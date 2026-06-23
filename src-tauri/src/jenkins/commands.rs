//! Tauri commands for the Jenkins integration.
//!
//! Registered in both `lib.rs` (`generate_handler!`) and
//! `http_server/dispatch.rs` (WebSocket transport).

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use super::client::JenkinsClient;
use super::config;
use super::freshness::{self, PreviewFreshness};
use super::parse;
use super::types::{JenkinsBuild, JenkinsStage, JenkinsWorktreeStatus};
use crate::gh_cli::config::resolve_gh_binary;
use crate::platform::silent_command;
use crate::projects::storage::{load_projects_data, save_projects_data};
use crate::projects::types::Project;

/// Umbrella pipeline job for a PR (covers unit / elm / integration / deploy stages).
pub const PIPELINE_JOB: &str = "build-and-test";
/// FreeStyle entry job triggered by the GitHub PR (serializes; queues first).
pub const LAUNCHER_JOB: &str = "build-and-test_Launcher-on-pr";
/// Standalone job that deploys the PR preview environment.
pub const PREVIEW_JOB: &str = "deploy-preview";
/// The flaky stage that gets re-run most often.
pub const INTEGRATION_STAGE: &str = "Integration tests";
/// Jobs whose queue items mean "the PR's pipeline is waiting to start".
const QUEUE_JOBS: &[&str] = &[PIPELINE_JOB, LAUNCHER_JOB];
/// The ghprb "retest" trigger phrase (Jenkins global config regex
/// `.*test\W+this\W+please.*`). Posted as a PR comment, it makes ghprb
/// re-trigger the Launcher build — see [`rerun_jenkins_pipeline`].
const GHPRB_RETEST_PHRASE: &str = "retest this please";

/// Resolve the preview **base** URL for a PR from the project's configured
/// template (`{pr}` placeholder, e.g. `https://{pr}.preview.example.com`).
///
/// Returns `None` when no template is configured, so the real internal preview
/// domain never has to be hardcoded in source. Both the admin link and the
/// freshness `/version` probe are derived from this single base.
pub fn preview_base_url(template: Option<&str>, pr_id: &str) -> Option<String> {
    let template = template.map(str::trim).filter(|t| !t.is_empty())?;
    let resolved = template.replace("{pr}", pr_id);
    let base = resolved.trim_end_matches('/');

    // Tolerate a template that already includes the `/admin` suffix: the admin
    // link and the `/version` probe are BOTH derived from the base, so a trailing
    // `/admin` would build `/admin/admin` and probe `/admin/version` — which the
    // admin SPA happily answers with index.html (HTTP 200, no `commit <sha>`),
    // masking the preview freshness as UNKNOWN (grey). Strip it so either the
    // base or the admin URL works.
    let base = match base.len().checked_sub("/admin".len()) {
        Some(cut) if base[cut..].eq_ignore_ascii_case("/admin") => &base[..cut],
        _ => base,
    };

    Some(base.trim_end_matches('/').to_string())
}

/// Build the preview admin URL for a PR (preview base + `/admin`).
pub fn preview_url(template: Option<&str>, pr_id: &str) -> Option<String> {
    preview_base_url(template, pr_id).map(|base| format!("{base}/admin"))
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Match a build to a worktree: prefer the `PR_ID` parameter, fall back to `BRANCH`.
fn match_build<'a>(
    builds: &'a [JenkinsBuild],
    pr_id: Option<&str>,
    branch: Option<&str>,
) -> Option<&'a JenkinsBuild> {
    if let Some(pr) = pr_id.filter(|p| !p.is_empty()) {
        if let Some(found) = parse::find_build_for_pr(builds, pr) {
            return Some(found);
        }
    }
    if let Some(br) = branch.filter(|b| !b.is_empty()) {
        return builds.iter().find(|b| b.branch.as_deref() == Some(br));
    }
    None
}

/// Assemble the full status for one worktree from already-fetched build lists.
///
/// Only the matched pipeline build's stages are fetched (one extra request).
/// Shared by [`get_jenkins_status`] and the background poller so the matching
/// logic stays in one place.
pub async fn assemble_status(
    client: &JenkinsClient,
    pipeline_builds: &[JenkinsBuild],
    preview_builds: &[JenkinsBuild],
    queue_json: &str,
    worktree_id: &str,
    pr_id: Option<&str>,
    branch: Option<&str>,
    preview_url_template: Option<&str>,
) -> JenkinsWorktreeStatus {
    let pipeline = match_build(pipeline_builds, pr_id, branch).cloned();

    let stages: Vec<JenkinsStage> = match &pipeline {
        Some(build) => client
            .fetch_stages(PIPELINE_JOB, build.number)
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };

    let preview = match_build(preview_builds, pr_id, branch).cloned();

    // Prefer the PR id actually carried by the matched build.
    let resolved_pr = pipeline
        .as_ref()
        .and_then(|b| b.pr_id.clone())
        .or_else(|| preview.as_ref().and_then(|b| b.pr_id.clone()))
        .or_else(|| pr_id.filter(|p| !p.is_empty()).map(str::to_string));

    // A queued pipeline (not yet a build) for this PR — e.g. waiting on the
    // serialized integration-test lock after a re-run.
    let queue = resolved_pr
        .as_deref()
        .and_then(|pr| parse::find_queued_for_pr(queue_json, pr, QUEUE_JOBS));

    let preview_url = resolved_pr
        .as_deref()
        .and_then(|pr| preview_url(preview_url_template, pr));
    let overall_status = parse::overall_status_with_queue(pipeline.as_ref(), queue.is_some());

    JenkinsWorktreeStatus {
        worktree_id: worktree_id.to_string(),
        pr_id: resolved_pr,
        pipeline,
        stages,
        preview,
        preview_url,
        // Filled by the caller (needs the worktree repo path + a `gh` read).
        preview_freshness: None,
        queue,
        overall_status,
        checked_at: now_secs(),
    }
}

/// Resolve live preview freshness for a worktree's PR (probe `/version`, compare
/// to the PR head). Returns `None` when there is no PR to attach a preview to.
pub(super) async fn resolve_preview_freshness(
    app: &AppHandle,
    repo_path: &str,
    pr_id: Option<&str>,
    pr_number: Option<u32>,
    preview_url_template: Option<&str>,
) -> Option<PreviewFreshness> {
    let pr_id = pr_id.filter(|p| !p.is_empty())?;
    // No configured preview domain → nothing to probe (and nothing hardcoded).
    let version_url = format!("{}/version", preview_base_url(preview_url_template, pr_id)?);
    let gh = resolve_gh_binary(app);
    Some(freshness::resolve_freshness(repo_path, pr_id, pr_number, gh, &version_url).await)
}

/// Live Jenkins status for the worktree's PR/branch.
#[tauri::command]
pub async fn get_jenkins_status(
    app: AppHandle,
    project_id: String,
    worktree_id: String,
    pr_id: Option<String>,
    branch: Option<String>,
) -> Result<JenkinsWorktreeStatus, String> {
    // Load data once: Jenkins config + the worktree (repo path / PR for freshness).
    let data = load_projects_data(&app)?;
    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    let cfg = config::config_from_project(project)?;
    let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

    let pipeline_builds = client.fetch_builds(PIPELINE_JOB).await?;
    let preview_builds = client.fetch_builds(PREVIEW_JOB).await.unwrap_or_default();
    let queue_json = client.fetch_queue().await.unwrap_or_default();

    let mut status = assemble_status(
        &client,
        &pipeline_builds,
        &preview_builds,
        &queue_json,
        &worktree_id,
        pr_id.as_deref(),
        branch.as_deref(),
        cfg.preview_url_template.as_deref(),
    )
    .await;

    if let Some(worktree) = data.worktrees.iter().find(|w| w.id == worktree_id) {
        status.preview_freshness = resolve_preview_freshness(
            &app,
            &worktree.path,
            status.pr_id.as_deref(),
            worktree.pr_number,
            cfg.preview_url_template.as_deref(),
        )
        .await;
    }

    Ok(status)
}

/// Re-run a PR's `build-and-test` pipeline by asking ghprb to retest it.
///
/// Neither Jenkins job can be re-triggered directly with the right effect:
/// - [`LAUNCHER_JOB`] (the ghprb entry point) is a FreeStyle job with **no build
///   parameters** — its ghprb context (`sha1`, `ghprbPullId`, …) is injected at
///   trigger time — so `POST …/buildWithParameters` answers **HTTP 500** ("Oops!
///   A problem occurred…"). That is the bug behind the original re-run error.
/// - Triggering [`PIPELINE_JOB`] directly *works*, but bypasses ghprb, so the
///   GitHub PR check / commit status never updates.
///
/// The supported re-run is therefore the ghprb **retest phrase**: a PR comment
/// ([`GHPRB_RETEST_PHRASE`]) that ghprb honors for repo admins and re-triggers
/// the Launcher with the right PR context on its next poll (~5 min) — preserving
/// the PR↔GitHub link. We post it with `gh` from the worktree's checkout.
#[tauri::command]
pub async fn rerun_jenkins_pipeline(
    app: AppHandle,
    project_id: String,
    worktree_id: Option<String>,
    pr_id: Option<String>,
    branch: Option<String>,
) -> Result<(), String> {
    let data = load_projects_data(&app)?;
    let pr_from_arg = pr_id.as_deref().and_then(parse_pr_number);

    // Resolve the PR's worktree (by id → PR number → branch). Needed for the repo
    // checkout where `gh` runs, and as a fallback source of the PR number.
    let worktree = worktree_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| data.worktrees.iter().find(|w| w.id == id))
        .or_else(|| {
            pr_from_arg.and_then(|pr| data.worktrees.iter().find(|w| w.pr_number == Some(pr)))
        })
        .or_else(|| {
            branch
                .as_deref()
                .filter(|b| !b.is_empty())
                .and_then(|b| data.worktrees.iter().find(|w| w.branch == b))
        });

    // `gh` runs in the PR's worktree checkout, falling back to the project repo.
    let repo_path = worktree
        .map(|w| w.path.clone())
        .or_else(|| data.find_project(&project_id).map(|p| p.path.clone()))
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            "Re-run: couldn't resolve a repository directory for this PR.".to_string()
        })?;

    let pr_number = pr_from_arg
        .or_else(|| worktree.and_then(|w| w.pr_number))
        .ok_or_else(|| {
            "Re-run needs an open PR — no PR number found for this worktree.".to_string()
        })?;

    let gh = resolve_gh_binary(&app);
    post_ghprb_retest_comment(repo_path, pr_number, gh).await
}

/// Parse a PR number from a possibly `#`-prefixed string (e.g. `"#3959"`).
fn parse_pr_number(raw: &str) -> Option<u32> {
    raw.trim().trim_start_matches('#').parse().ok()
}

/// Post the ghprb retest phrase on a PR via `gh pr comment` (blocking → off-thread).
async fn post_ghprb_retest_comment(
    repo_path: String,
    pr_number: u32,
    gh: std::path::PathBuf,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = silent_command(&gh)
            .args([
                "pr",
                "comment",
                &pr_number.to_string(),
                "--body",
                GHPRB_RETEST_PHRASE,
            ])
            .current_dir(&repo_path)
            .output()
            .map_err(|e| format!("Failed to run gh: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "gh pr comment failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    })
    .await
    .map_err(|e| format!("Re-run task failed to join: {e}"))?
}

/// Restart only the flaky `Integration tests` stage of a pipeline build.
///
/// On failure, surfaces an error suggesting a full re-run (no silent 37-min rebuild).
#[tauri::command]
pub async fn restart_jenkins_integration(
    app: AppHandle,
    project_id: String,
    build_number: u64,
) -> Result<(), String> {
    let cfg = config::load_config(&app, &project_id)?;
    let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

    client
        .restart_stage(PIPELINE_JOB, build_number, INTEGRATION_STAGE)
        .await
        .map_err(|e| format!("Could not restart the Integration tests stage ({e}). Use “Re-run pipeline” instead."))
}

/// Persist per-project Jenkins config (URL + user + token + preview template).
/// Empty values → cleared. `preview_url_template` is optional (defaults to unset).
#[tauri::command]
pub async fn save_jenkins_config(
    app: AppHandle,
    project_id: String,
    url: String,
    user: String,
    token: String,
    preview_url_template: Option<String>,
) -> Result<Project, String> {
    let mut data = load_projects_data(&app)?;
    let project = data
        .find_project_mut(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    project.jenkins_url = clean(url);
    project.jenkins_user = clean(user);
    project.jenkins_token = clean(token);
    project.jenkins_preview_url_template = preview_url_template.and_then(clean);

    let updated = data
        .find_project(&project_id)
        .expect("project exists after mutation")
        .clone();
    save_projects_data(&app, &data)?;
    Ok(updated)
}

fn clean(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Force the background poller to run a cycle now (e.g. on window focus) instead
/// of waiting out the adaptive interval. Cheap: just wakes the existing loop.
#[tauri::command]
pub fn poke_jenkins_poll(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    app.state::<super::poller::JenkinsPollSignal>().poke();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(number: u64, pr: Option<&str>, branch: Option<&str>) -> JenkinsBuild {
        JenkinsBuild {
            number,
            result: Some("SUCCESS".into()),
            building: false,
            timestamp_ms: 0,
            duration_ms: 0,
            url: String::new(),
            pr_id: pr.map(str::to_string),
            branch: branch.map(str::to_string),
        }
    }

    #[test]
    fn preview_urls_derive_from_base_template() {
        let tpl = Some("https://{pr}.preview.example.com");
        assert_eq!(
            preview_base_url(tpl, "3959").as_deref(),
            Some("https://3959.preview.example.com")
        );
        assert_eq!(
            preview_url(tpl, "3959").as_deref(),
            Some("https://3959.preview.example.com/admin")
        );
        // Trailing slash in the template doesn't double up.
        assert_eq!(
            preview_url(Some("https://{pr}.preview.example.com/"), "42").as_deref(),
            Some("https://42.preview.example.com/admin")
        );
        // No template configured → nothing (nothing hardcoded).
        assert_eq!(preview_url(None, "3959"), None);
        assert_eq!(preview_base_url(Some("   "), "3959"), None);
    }

    #[test]
    fn preview_base_strips_trailing_admin_suffix() {
        // A template that already ends in `/admin` must not double up or probe
        // `/admin/version` — the base is normalized back to the host root.
        let tpl = Some("https://{pr}.preview.example.com/admin");
        assert_eq!(
            preview_base_url(tpl, "3905").as_deref(),
            Some("https://3905.preview.example.com")
        );
        assert_eq!(
            preview_url(tpl, "3905").as_deref(),
            Some("https://3905.preview.example.com/admin")
        );
        // Case-insensitive + trailing slash variants normalize the same way.
        assert_eq!(
            preview_base_url(Some("https://{pr}.preview.example.com/Admin/"), "42").as_deref(),
            Some("https://42.preview.example.com")
        );
        // A path that merely contains "admin" elsewhere is left untouched.
        assert_eq!(
            preview_base_url(Some("https://admin.example.com/{pr}"), "42").as_deref(),
            Some("https://admin.example.com/42")
        );
    }

    #[test]
    fn match_build_prefers_pr_id() {
        let builds = vec![
            build(2, Some("3960"), Some("feat-x")),
            build(1, Some("3959"), Some("feat-y")),
        ];
        assert_eq!(match_build(&builds, Some("3959"), None).unwrap().number, 1);
    }

    #[test]
    fn match_build_falls_back_to_branch() {
        let builds = vec![build(7, None, Some("perf-pagination"))];
        assert_eq!(
            match_build(&builds, Some("404"), Some("perf-pagination"))
                .unwrap()
                .number,
            7
        );
    }

    #[test]
    fn match_build_returns_none_without_pr_or_branch() {
        let builds = vec![build(1, Some("3959"), Some("feat"))];
        assert!(match_build(&builds, None, None).is_none());
        assert!(match_build(&builds, Some(""), Some("")).is_none());
    }

    #[test]
    fn parse_pr_number_strips_hash_and_whitespace() {
        assert_eq!(parse_pr_number(" #3959 "), Some(3959));
        assert_eq!(parse_pr_number("404"), Some(404));
        assert_eq!(parse_pr_number(""), None);
        assert_eq!(parse_pr_number("feat-x"), None);
    }

    #[test]
    fn retest_phrase_satisfies_ghprb_regex() {
        // ghprb global config: retestPhrase = `.*test\W+this\W+please.*`. Cheap
        // guard that the constant we post still carries the three anchor words in
        // order so a phrase typo can't silently make the re-run a no-op.
        let p = GHPRB_RETEST_PHRASE;
        let test = p.find("test").expect("test");
        let this = p[test..].find("this").expect("this");
        assert!(
            p[test + this..].contains("please"),
            "words out of order: {p}"
        );
    }

    #[test]
    fn clean_blanks_to_none() {
        assert_eq!(clean("  ".into()), None);
        assert_eq!(clean(" http://x ".into()), Some("http://x".to_string()));
    }
}
