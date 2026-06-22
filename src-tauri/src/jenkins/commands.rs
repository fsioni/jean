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
use crate::projects::storage::{load_projects_data, save_projects_data};
use crate::projects::types::Project;

/// Umbrella pipeline job for a PR (covers unit / elm / integration / deploy stages).
pub const PIPELINE_JOB: &str = "build-and-test";
/// FreeStyle entry job triggered by the GitHub PR (serializes; queues first).
pub const LAUNCHER_JOB: &str = "build-and-test_Launcher-on-pr";
/// Standalone job that deploys the PR preview environment.
pub const PREVIEW_JOB: &str = "deploy-preview";
/// The flaky stage Farès re-runs most.
pub const INTEGRATION_STAGE: &str = "Integration tests";
/// Jobs whose queue items mean "the PR's pipeline is waiting to start".
const QUEUE_JOBS: &[&str] = &[PIPELINE_JOB, LAUNCHER_JOB];

/// Build the preview admin URL for a PR (e.g. `https://3959.preview.example.com/admin`).
pub fn preview_url(pr_id: &str) -> String {
    format!("https://{pr_id}.preview.example.com/admin")
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

    let preview_url = resolved_pr.as_deref().map(preview_url);
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
) -> Option<PreviewFreshness> {
    let pr_id = pr_id.filter(|p| !p.is_empty())?;
    let gh = resolve_gh_binary(app);
    Some(freshness::resolve_freshness(repo_path, pr_id, pr_number, gh).await)
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
    )
    .await;

    if let Some(worktree) = data.worktrees.iter().find(|w| w.id == worktree_id) {
        status.preview_freshness = resolve_preview_freshness(
            &app,
            &worktree.path,
            status.pr_id.as_deref(),
            worktree.pr_number,
        )
        .await;
    }

    Ok(status)
}

/// Re-run the whole `build-and-test` pipeline, replaying the last build's parameters.
#[tauri::command]
pub async fn rerun_jenkins_pipeline(
    app: AppHandle,
    project_id: String,
    pr_id: Option<String>,
    branch: Option<String>,
) -> Result<(), String> {
    let cfg = config::load_config(&app, &project_id)?;
    let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

    let builds = client.fetch_builds(PIPELINE_JOB).await?;
    let last = match_build(&builds, pr_id.as_deref(), branch.as_deref())
        .ok_or_else(|| "No previous build found for this PR/branch to re-run".to_string())?;

    let params = client
        .fetch_build_parameters(PIPELINE_JOB, last.number)
        .await?;
    client.trigger_with_parameters(PIPELINE_JOB, &params).await
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

/// Persist per-project Jenkins config (URL + user + token). Empty → cleared.
#[tauri::command]
pub async fn save_jenkins_config(
    app: AppHandle,
    project_id: String,
    url: String,
    user: String,
    token: String,
) -> Result<Project, String> {
    let mut data = load_projects_data(&app)?;
    let project = data
        .find_project_mut(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    project.jenkins_url = clean(url);
    project.jenkins_user = clean(user);
    project.jenkins_token = clean(token);

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
    fn preview_url_uses_pr_id() {
        assert_eq!(preview_url("3959"), "https://3959.preview.example.com/admin");
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
    fn clean_blanks_to_none() {
        assert_eq!(clean("  ".into()), None);
        assert_eq!(clean(" http://x ".into()), Some("http://x".to_string()));
    }
}
