//! Background polling loop: tracks each PR-linked worktree's pipeline, fires a
//! native desktop notification when a build breaks or recovers, and broadcasts
//! a `jenkins:status-update` event for the live UI.
//!
//! Self-contained: spawned once from `lib.rs` setup. Keeps last-seen results in
//! memory so transitions are detected across polls. Skips projects without
//! Jenkins config and worktrees without a PR.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

use super::client::JenkinsClient;
use super::commands::{
    assemble_status, resolve_preview_freshness, INTEGRATION_JOB, PIPELINE_JOB, PREVIEW_JOB,
};
use super::parse::{self, Transition, STATUS_FAILURE, STATUS_SUCCESS};
use super::{config, types::JenkinsWorktreeStatus};
use crate::http_server::EmitExt;
use crate::projects::storage::load_projects_data;

/// Idle cadence when nothing is building.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Faster cadence while a build is in progress / queued, so the CI pills feel
/// live during a run without hammering Jenkins the rest of the time.
const ACTIVE_POLL_INTERVAL: Duration = Duration::from_secs(12);
const STATUS_EVENT: &str = "jenkins:status-update";

/// Wake signal: lets the UI force an immediate poll (e.g. on window focus)
/// instead of waiting out the current interval. Managed in Tauri state and
/// awaited by [`start_poller`]. Cheap — just nudges the existing loop.
#[derive(Clone, Default)]
pub struct JenkinsPollSignal(pub Arc<Notify>);

impl JenkinsPollSignal {
    /// Wake the poller now. Coalesces if it's mid-cycle (at most one extra run).
    pub fn poke(&self) {
        self.0.notify_one();
    }
}

/// Run the polling loop forever. Errors in a single cycle are logged and retried.
///
/// Adaptive cadence: polls every [`ACTIVE_POLL_INTERVAL`] while any tracked
/// build is BUILDING/QUEUED, else every [`IDLE_POLL_INTERVAL`]. A `signal.poke()`
/// (window focus) wakes it immediately regardless of the current interval.
pub async fn start_poller(app: AppHandle, signal: JenkinsPollSignal) -> Result<(), String> {
    log::info!(
        "Jenkins poller started (idle {}s / active {}s, focus-triggered)",
        IDLE_POLL_INTERVAL.as_secs(),
        ACTIVE_POLL_INTERVAL.as_secs()
    );
    // (project_id, pr_id) -> last terminal overall status (SUCCESS/FAILURE).
    let mut last_results: HashMap<(String, String), String> = HashMap::new();

    loop {
        let any_active = match poll_cycle(&app, &mut last_results).await {
            Ok(active) => active,
            Err(e) => {
                log::debug!("Jenkins poll cycle error: {e}");
                false
            }
        };
        let interval = if any_active {
            ACTIVE_POLL_INTERVAL
        } else {
            IDLE_POLL_INTERVAL
        };

        // Wake on whichever comes first: the interval elapsing, or a focus poke.
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = signal.0.notified() => {
                log::debug!("Jenkins poll: woken early (focus/poke)");
            }
        }
    }
}

/// Returns `true` if any tracked worktree is BUILDING/QUEUED — the caller speeds
/// up the cadence while something is in flight.
async fn poll_cycle(
    app: &AppHandle,
    last_results: &mut HashMap<(String, String), String>,
) -> Result<bool, String> {
    let data = load_projects_data(app)?;

    // Per-cycle observability: how many projects are Jenkins-configured and how
    // many PR-linked worktrees we actually polled. Logged at info so the poller
    // is visible in prod without trace logging (notif-diagnostic cause D).
    let mut configured_projects = 0usize;
    let mut polled_worktrees = 0usize;
    // Any in-flight build/queue this cycle → caller polls faster next time.
    let mut any_active = false;

    for project in &data.projects {
        // Skip projects without Jenkins configured.
        let Ok(cfg) = config::config_from_project(project) else {
            log::debug!(
                "Jenkins poll: skip project '{}' — no Jenkins config",
                project.name
            );
            continue;
        };
        configured_projects += 1;
        let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

        // Fetch each job's builds once per project, then match per worktree.
        let Ok(pipeline_builds) = client.fetch_builds(PIPELINE_JOB).await else {
            log::debug!(
                "Jenkins poll: project '{}' — failed to fetch {PIPELINE_JOB} builds",
                project.name
            );
            continue;
        };
        let preview_builds = client.fetch_builds(PREVIEW_JOB).await.unwrap_or_default();
        let integration_builds = client
            .fetch_builds(INTEGRATION_JOB)
            .await
            .unwrap_or_default();
        let queue_json = client.fetch_queue().await.unwrap_or_default();

        for worktree in data.worktrees.iter().filter(|w| w.project_id == project.id) {
            // v1: only track worktrees linked to a PR.
            let Some(pr_number) = worktree.pr_number else {
                log::debug!(
                    "Jenkins poll: skip worktree '{}' — no linked PR",
                    worktree.name
                );
                continue;
            };
            polled_worktrees += 1;
            let pr_id = pr_number.to_string();

            let mut status = assemble_status(
                &client,
                &pipeline_builds,
                &preview_builds,
                &integration_builds,
                &queue_json,
                &worktree.id,
                Some(&pr_id),
                Some(&worktree.branch),
                cfg.preview_url_template.as_deref(),
            )
            .await;

            status.preview_freshness = resolve_preview_freshness(
                app,
                &worktree.path,
                status.pr_id.as_deref(),
                worktree.pr_number,
                cfg.preview_url_template.as_deref(),
            )
            .await;

            if matches!(status.overall_status.as_str(), "BUILDING" | "QUEUED") {
                any_active = true;
            }

            let _ = app.emit_all(STATUS_EVENT, &status);
            track_transition(app, last_results, &project.id, &pr_id, &status);
        }
    }

    log::info!(
        "Jenkins poll cycle: {configured_projects} configured project(s), {polled_worktrees} PR-linked worktree(s) polled{}",
        if any_active { " — active build" } else { "" }
    );

    Ok(any_active)
}

/// Notify on a green↔red transition of a completed pipeline build.
fn track_transition(
    app: &AppHandle,
    last_results: &mut HashMap<(String, String), String>,
    project_id: &str,
    pr_id: &str,
    status: &JenkinsWorktreeStatus,
) {
    // Only consider completed builds — ignore in-progress/unknown.
    let Some(pipeline) = &status.pipeline else {
        return;
    };
    if pipeline.building {
        return;
    }
    let new_status = status.overall_status.as_str();
    if new_status != STATUS_SUCCESS && new_status != STATUS_FAILURE {
        return;
    }

    let key = (project_id.to_string(), pr_id.to_string());
    let previous = last_results.get(&key).map(String::as_str);

    if let Some(transition) = parse::detect_transition(previous, new_status) {
        notify(app, transition, pr_id, status);
    } else if previous.is_none() {
        // First terminal result seen for this PR since startup: recorded as the
        // baseline, no notification (anti-spam). We only notify on a flip while
        // the app is running. Logged so this expected silence is observable
        // (notif-diagnostic cause A).
        log::debug!(
            "Jenkins poll: PR #{pr_id} baseline = {new_status} (no notification at startup)"
        );
    }
    last_results.insert(key, new_status.to_string());
}

fn notify(app: &AppHandle, transition: Transition, pr_id: &str, status: &JenkinsWorktreeStatus) {
    let (title, body) = match transition {
        Transition::Broke => {
            // Verdict is the global build-and-test result; name the failed stage as detail.
            let detail = status
                .stages
                .iter()
                .find(|s| s.status == "FAILED")
                .map_or_else(
                    || "Le pipeline a échoué".to_string(),
                    |s| format!("Stage en échec : « {} »", s.name),
                );
            (format!("❌ build-and-test en échec — PR #{pr_id}"), detail)
        }
        Transition::Recovered => (
            format!("✅ build-and-test repassé au vert — PR #{pr_id}"),
            "Le pipeline de la PR est de nouveau vert".to_string(),
        ),
    };

    log::info!("Jenkins notification (PR #{pr_id}): {title}");
    if let Err(e) = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
    {
        log::warn!("Failed to show Jenkins notification: {e}");
    }
}
