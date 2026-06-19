//! Background polling loop: tracks each PR-linked worktree's pipeline, fires a
//! native desktop notification when a build breaks or recovers, and broadcasts
//! a `jenkins:status-update` event for the live UI.
//!
//! Self-contained: spawned once from `lib.rs` setup. Keeps last-seen results in
//! memory so transitions are detected across polls. Skips projects without
//! Jenkins config and worktrees without a PR.

use std::collections::HashMap;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use super::client::JenkinsClient;
use super::commands::{assemble_status, PIPELINE_JOB, PREVIEW_JOB};
use super::parse::{self, Transition, STATUS_FAILURE, STATUS_SUCCESS};
use super::{config, types::JenkinsWorktreeStatus};
use crate::http_server::EmitExt;
use crate::projects::storage::load_projects_data;

const POLL_INTERVAL: Duration = Duration::from_secs(60);
const STATUS_EVENT: &str = "jenkins:status-update";

/// Run the polling loop forever. Errors in a single cycle are logged and retried.
pub async fn start_poller(app: AppHandle) -> Result<(), String> {
    log::info!(
        "Jenkins poller started ({}s interval)",
        POLL_INTERVAL.as_secs()
    );
    // (project_id, pr_id) -> last terminal overall status (SUCCESS/FAILURE).
    let mut last_results: HashMap<(String, String), String> = HashMap::new();

    loop {
        if let Err(e) = poll_cycle(&app, &mut last_results).await {
            log::trace!("Jenkins poll cycle error: {e}");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn poll_cycle(
    app: &AppHandle,
    last_results: &mut HashMap<(String, String), String>,
) -> Result<(), String> {
    let data = load_projects_data(app)?;

    for project in &data.projects {
        // Skip projects without Jenkins configured.
        let Ok(cfg) = config::config_from_project(project) else {
            continue;
        };
        let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

        // Fetch each job's builds once per project, then match per worktree.
        let Ok(pipeline_builds) = client.fetch_builds(PIPELINE_JOB).await else {
            continue;
        };
        let preview_builds = client.fetch_builds(PREVIEW_JOB).await.unwrap_or_default();

        for worktree in data.worktrees.iter().filter(|w| w.project_id == project.id) {
            // v1: only track worktrees linked to a PR.
            let Some(pr_number) = worktree.pr_number else {
                continue;
            };
            let pr_id = pr_number.to_string();

            let status = assemble_status(
                &client,
                &pipeline_builds,
                &preview_builds,
                &worktree.id,
                Some(&pr_id),
                Some(&worktree.branch),
            )
            .await;

            let _ = app.emit_all(STATUS_EVENT, &status);
            track_transition(app, last_results, &project.id, &pr_id, &status);
        }
    }

    Ok(())
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

    if let Err(e) = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
    {
        log::trace!("Failed to show Jenkins notification: {e}");
    }
}
