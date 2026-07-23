//! Tauri commands for the Jenkins integration.
//!
//! Registered in both `lib.rs` (`generate_handler!`) and
//! `http_server/dispatch.rs` (WebSocket transport).

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use super::client::JenkinsClient;
use super::config;
use super::freshness::{self, PreviewFreshness};
use super::gh_checks::{self, PrChecks};
use super::parse;
use super::types::{
    JenkinsBuild, JenkinsFailureReport, JenkinsStage, JenkinsWorktreeStatus, SOURCE_GITHUB,
    SOURCE_JENKINS, SOURCE_NONE,
};
use crate::gh_cli::config::resolve_gh_binary;
use crate::platform::silent_command;
use crate::projects::storage::{load_projects_data, save_projects_data};
use crate::projects::types::Project;

// A PR build runs through three chained jobs: the ghprb launcher triggers the
// router, which dispatches to the unified pipeline (tests + build + deploys),
// which in turn triggers the preview deploy. The verdict, stages and preview all
// come from the last two.
//
/// Unified pipeline job: tests, single build, and the optional deploys
/// (preview / testing / preprod / prod).
pub const PIPELINE_JOB: &str = "unified-build-test-deploy";
/// FreeStyle entry job triggered by the GitHub PR (serializes; queues first).
/// Still the ghprb entry point, and still what the PR's commit status links to.
pub const LAUNCHER_JOB: &str = "build-and-test_Launcher-on-pr";
/// Job the launcher triggers, which dispatches to [`PIPELINE_JOB`] (or, on
/// explicit opt-in, to the legacy pipeline — those builds have no unified build,
/// so the status falls back to the GitHub commit status).
pub const ROUTER_JOB: &str = "pr-build-router";
/// Job the pipeline's `Deploy preview` stage launches to deploy the PR preview.
pub const PREVIEW_JOB: &str = "unified-deploy-preview";
/// The flaky stage that gets re-run most often — it retries in place, so its
/// steps are the [`JenkinsAttempt`]s.
pub const FLAKY_STAGE: &str = "Cypress Unified";
/// Jobs whose queue items mean "the PR's pipeline is waiting to start".
const QUEUE_JOBS: &[&str] = &[PIPELINE_JOB, ROUTER_JOB, LAUNCHER_JOB];
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

/// Match a build to a worktree: prefer the `PR_ID` parameter, fall back to the
/// branch one.
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
/// Only the matched pipeline build's stages are fetched (one extra request,
/// which also carries the flaky stage's attempts). Shared by
/// [`get_jenkins_status`] and the background poller so the matching logic stays
/// in one place.
///
/// `gh_verdict` is the GitHub commit-status fallback for this PR (see
/// [`gh_checks`]): used only when Jenkins has no matching build left, which on a
/// busy controller happens within hours.
pub async fn assemble_status(
    client: &JenkinsClient,
    pipeline_builds: &[JenkinsBuild],
    preview_builds: &[JenkinsBuild],
    queue_json: &str,
    worktree_id: &str,
    pr_id: Option<&str>,
    branch: Option<&str>,
    preview_url_template: Option<&str>,
    gh_verdict: Option<&str>,
) -> JenkinsWorktreeStatus {
    let pipeline = match_build(pipeline_builds, pr_id, branch).cloned();

    // One `wfapi/describe?fullStages=true` gives both the stage breakdown and
    // the per-attempt detail of the flaky stage (which retries in place).
    let stages_json = match &pipeline {
        Some(build) => client
            .fetch_stages_json(PIPELINE_JOB, build.number)
            .await
            .unwrap_or_default(),
        None => String::new(),
    };
    let stages: Vec<JenkinsStage> = parse::parse_stages(&stages_json).unwrap_or_default();
    let integration_attempts =
        parse::parse_stage_attempts(&stages_json, FLAKY_STAGE, client.base_url());

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

    // Jenkins first; fall back to the GitHub commit status when it kept no
    // build for this PR, so an old-but-known verdict beats a blank row.
    let jenkins_status = parse::overall_status_with_queue(pipeline.as_ref(), queue.is_some());
    let (overall_status, verdict_source) = if jenkins_status == parse::STATUS_UNKNOWN {
        match gh_verdict.filter(|v| !v.is_empty()) {
            Some(v) => (v.to_string(), SOURCE_GITHUB),
            None => (jenkins_status, SOURCE_NONE),
        }
    } else {
        (jenkins_status, SOURCE_JENKINS)
    };

    JenkinsWorktreeStatus {
        worktree_id: worktree_id.to_string(),
        pr_id: resolved_pr,
        pipeline,
        stages,
        integration_attempts,
        preview,
        preview_url,
        // Filled by the caller (needs the worktree repo path + a `gh` read).
        preview_freshness: None,
        queue,
        overall_status,
        verdict_source: verdict_source.to_string(),
        checked_at: now_secs(),
    }
}

/// `REVISION` of the PR's last **successful** preview deploy — the commit
/// Jenkins was asked to put live.
///
/// Only a fallback: some previews answer `/version` with a 404 (the compose
/// deploys don't publish the file), and a deployed-but-unverified commit still
/// beats showing nothing. Failed deploys are skipped — they put nothing live.
pub(super) fn deployed_revision(
    preview_builds: &[JenkinsBuild],
    pr_id: Option<&str>,
    branch: Option<&str>,
) -> Option<String> {
    let successful: Vec<JenkinsBuild> = preview_builds
        .iter()
        .filter(|b| b.result.as_deref() == Some(parse::STATUS_SUCCESS))
        .cloned()
        .collect();
    match_build(&successful, pr_id, branch)?.revision.clone()
}

/// Resolve live preview freshness for a worktree's PR (probe `/version`, compare
/// to the PR head). Returns `None` when there is no PR to attach a preview to.
///
/// `pr_head_sha` is the head commit already known from the project-wide
/// [`gh_checks`] call; when present it spares one `gh pr view` subprocess per
/// worktree per poll cycle. `deployed_sha` is the [`deployed_revision`]
/// fallback for previews that publish no `/version`.
pub(super) async fn resolve_preview_freshness(
    app: &AppHandle,
    repo_path: &str,
    pr_id: Option<&str>,
    pr_number: Option<u32>,
    preview_url_template: Option<&str>,
    pr_head_sha: Option<String>,
    deployed_sha: Option<String>,
) -> Option<PreviewFreshness> {
    let pr_id = pr_id.filter(|p| !p.is_empty())?;
    // No configured preview domain → nothing to probe (and nothing hardcoded).
    let version_url = format!("{}/version", preview_base_url(preview_url_template, pr_id)?);
    let gh = resolve_gh_binary(app);
    Some(
        freshness::resolve_freshness(
            repo_path,
            pr_number,
            gh,
            &version_url,
            pr_head_sha,
            deployed_sha,
        )
        .await,
    )
}

/// Live Jenkins status for the worktree's PR/branch.
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

    let worktree = data.worktrees.iter().find(|w| w.id == worktree_id);
    // GitHub commit statuses outlive Jenkins' short build retention — the
    // fallback verdict (and the PR head for the freshness probe) come from here.
    let gh_check = fetch_pr_checks_for(&app, worktree.map_or(project.path.as_str(), |w| &w.path))
        .await
        .remove(&worktree.and_then(|w| w.pr_number).unwrap_or_default())
        .unwrap_or_default();

    let mut status = assemble_status(
        &client,
        &pipeline_builds,
        &preview_builds,
        &queue_json,
        &worktree_id,
        pr_id.as_deref(),
        branch.as_deref(),
        cfg.preview_url_template.as_deref(),
        gh_check.verdict.as_deref(),
    )
    .await;

    if let Some(worktree) = worktree {
        let deployed =
            deployed_revision(&preview_builds, status.pr_id.as_deref(), branch.as_deref());
        status.preview_freshness = resolve_preview_freshness(
            &app,
            &worktree.path,
            status.pr_id.as_deref(),
            worktree.pr_number,
            cfg.preview_url_template.as_deref(),
            gh_check.head_sha,
            deployed,
        )
        .await;
    }

    Ok(status)
}

/// Fetch the GitHub checks of every open PR of a repo, off the async runtime.
pub(super) async fn fetch_pr_checks_for(app: &AppHandle, repo_path: &str) -> PrChecks {
    let gh = resolve_gh_binary(app);
    let repo = repo_path.to_string();
    tokio::task::spawn_blocking(move || gh_checks::fetch_pr_checks(&repo, &gh))
        .await
        .unwrap_or_default()
}

/// One PR/branch to resolve a status for, in a batch request.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JenkinsStatusTarget {
    /// Opaque id echoed back as `worktreeId` so the caller can join the result.
    pub key: String,
    pub pr_id: Option<String>,
    pub branch: Option<String>,
}

/// Cap on a batch request — a safety net, not an expected limit.
const MAX_STATUS_TARGETS: usize = 30;

/// Statuses for several PRs at once, fetching each Jenkins job's build list
/// **once** for the whole batch.
///
/// Exists for the PRs that have no worktree: the background poller only walks
/// PR-linked worktrees, so nothing populates their status cache. Calling
/// [`get_jenkins_status`] per PR would re-fetch every build list each time (4
/// requests × N); this pays that cost once.
///
/// No preview freshness: that needs a repo checkout, which is precisely what
/// these PRs lack.
pub async fn get_jenkins_statuses(
    app: AppHandle,
    project_id: String,
    targets: Vec<JenkinsStatusTarget>,
) -> Result<Vec<JenkinsWorktreeStatus>, String> {
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let data = load_projects_data(&app)?;
    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    let cfg = config::config_from_project(project)?;
    let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

    let pipeline_builds = client.fetch_builds(PIPELINE_JOB).await?;
    let preview_builds = client.fetch_builds(PREVIEW_JOB).await.unwrap_or_default();
    let queue_json = client.fetch_queue().await.unwrap_or_default();
    // These PRs are the likeliest to have been rotated out of Jenkins' short
    // build history, so the GitHub fallback verdict matters even more here.
    let gh_checks = fetch_pr_checks_for(&app, &project.path).await;

    let mut out = Vec::with_capacity(targets.len());
    for target in targets.iter().take(MAX_STATUS_TARGETS) {
        let gh_verdict = target
            .pr_id
            .as_deref()
            .and_then(|pr| pr.parse::<u32>().ok())
            .and_then(|pr| gh_checks.get(&pr))
            .and_then(|check| check.verdict.as_deref());
        out.push(
            assemble_status(
                &client,
                &pipeline_builds,
                &preview_builds,
                &queue_json,
                &target.key,
                target.pr_id.as_deref(),
                target.branch.as_deref(),
                cfg.preview_url_template.as_deref(),
                gh_verdict,
            )
            .await,
        );
    }
    Ok(out)
}

/// Re-run a PR's pipeline by asking ghprb to retest it.
///
/// No Jenkins job in the chain can be re-triggered directly with the right effect:
/// - [`LAUNCHER_JOB`] (the ghprb entry point) is a FreeStyle job with **no build
///   parameters** — its ghprb context (`sha1`, `ghprbPullId`, …) is injected at
///   trigger time — so `POST …/buildWithParameters` answers **HTTP 500** ("Oops!
///   A problem occurred…"). That is the bug behind the original re-run error.
/// - Triggering [`ROUTER_JOB`] or [`PIPELINE_JOB`] directly *works*, but bypasses
///   ghprb, so the GitHub PR check / commit status never updates.
///
/// The supported re-run is therefore the ghprb **retest phrase**: a PR comment
/// ([`GHPRB_RETEST_PHRASE`]) that ghprb honors for repo admins and re-triggers
/// the Launcher with the right PR context on its next poll (~5 min) — preserving
/// the PR↔GitHub link. We post it with `gh` from the worktree's checkout.
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

/// Max failing test cases returned inline (the rest stay on Jenkins).
const MAX_FAILED_TESTS: usize = 15;
/// Console tail fetched for the failing build. Planexpo logs run 20–80 KB, so
/// this keeps whole logs while capping pathological ones.
const CONSOLE_TAIL_BYTES: u64 = 256 * 1024;

/// Diagnose why a PR's pipeline failed, WITHOUT opening Jenkins.
///
/// Drills down: pipeline build → first FAILED stage → the failing step's log →
/// the downstream job that step delegated to, when it delegated at all (deploy
/// stages do; test stages run inline, and publish their JUnit report on the
/// pipeline build itself). Returns the failing tests plus a cleaned log excerpt,
/// ready to read inline or hand to the agent.
///
/// Errors only when Jenkins is unreachable / misconfigured; a build with no
/// identifiable failure still returns a report with empty fields.
pub async fn get_jenkins_failure_report(
    app: AppHandle,
    project_id: String,
    worktree_id: Option<String>,
    pr_id: Option<String>,
    branch: Option<String>,
) -> Result<JenkinsFailureReport, String> {
    let _ = worktree_id; // Kept for symmetry with the other Jenkins commands.
    let cfg = config::load_config(&app, &project_id)?;
    let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

    let pipeline_builds = client.fetch_builds(PIPELINE_JOB).await?;
    let build = match_build(&pipeline_builds, pr_id.as_deref(), branch.as_deref())
        .ok_or_else(|| "No Jenkins build found for this PR.".to_string())?;

    let mut report = JenkinsFailureReport {
        pipeline_number: build.number,
        stage: None,
        downstream_job: None,
        downstream_number: None,
        console_url: Some(format!("{}console", build.url)),
        failed_tests: Vec::new(),
        failed_test_count: 0,
        log_excerpt: String::new(),
    };

    // 1. Which stage broke?
    let stages_json = client.fetch_stages_json(PIPELINE_JOB, build.number).await?;
    let Some((stage_node, stage_name)) = parse::find_failed_stage(&stages_json) else {
        return Ok(report);
    };
    report.stage = Some(stage_name);

    // 2. Which step inside it, and what did that step log?
    let raw_log = match client
        .fetch_stage_node_json(PIPELINE_JOB, build.number, &stage_node)
        .await
        .ok()
        .and_then(|json| parse::find_failed_node(&json))
    {
        Some(node) => {
            let (text, console_url) = client
                .fetch_node_log_json(PIPELINE_JOB, build.number, &node)
                .await
                .map(|json| parse::parse_node_log(&json))
                .unwrap_or_default();
            if let Some(url) = console_url {
                report.console_url = Some(absolute_jenkins_url(&cfg.url, &url));
            }
            text
        }
        None => String::new(),
    };

    // 3. A stage that only orchestrates a downstream job — follow it for the real
    //    output. Otherwise the stage's own log IS the output.
    let (log_job, log_build) =
        match parse::find_downstream_build(&parse::strip_log_markup(&raw_log)) {
            Some((job, number)) => {
                report.downstream_job = Some(job.clone());
                report.downstream_number = Some(number);
                report.console_url =
                    Some(format!("{}/job/{job}/{number}/console", trim_url(&cfg.url)));
                (job, number)
            }
            None => {
                report.log_excerpt = parse::clean_log_excerpt(&raw_log);
                (PIPELINE_JOB.to_string(), build.number)
            }
        };

    if report.log_excerpt.is_empty() {
        report.log_excerpt = client
            .fetch_console_tail(&log_job, log_build, CONSOLE_TAIL_BYTES)
            .await
            .map(|raw| parse::clean_log_excerpt(&raw))
            .unwrap_or_default();
    }

    // 4. Named failing tests, when the job published a JUnit report.
    if let Ok(Some(json)) = client.fetch_test_report(&log_job, log_build).await {
        let (tests, total) = parse::parse_failed_tests(&json, MAX_FAILED_TESTS);
        report.failed_tests = tests;
        report.failed_test_count = total;
    }

    Ok(report)
}

fn trim_url(base: &str) -> &str {
    base.trim().trim_end_matches('/')
}

/// Jenkins `_links` hrefs are controller-relative (`/job/x/1/…`).
fn absolute_jenkins_url(base: &str, href: &str) -> String {
    if href.starts_with("http") {
        href.to_string()
    } else {
        format!("{}{href}", trim_url(base))
    }
}

/// Restart a pipeline build from its flaky end-to-end stage ([`FLAKY_STAGE`]),
/// skipping the test/build stages that already passed.
///
/// On failure, surfaces an error suggesting a full re-run (no silent 37-min rebuild).
pub async fn restart_jenkins_integration(
    app: AppHandle,
    project_id: String,
    build_number: u64,
) -> Result<(), String> {
    let cfg = config::load_config(&app, &project_id)?;
    let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

    client
        .restart_stage(PIPELINE_JOB, build_number, FLAKY_STAGE)
        .await
        .map_err(|e| {
            format!(
                "Could not restart the {FLAKY_STAGE} stage ({e}). Use “Re-run pipeline” instead."
            )
        })
}

/// Persist per-project Jenkins config (URL + user + token + preview template).
/// Empty values → cleared. `preview_url_template` is optional (defaults to unset).
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
pub fn poke_jenkins_poll(app: AppHandle) -> Result<(), String> {
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
            revision: None,
            upstream_build: None,
        }
    }

    #[test]
    fn deployed_revision_takes_the_last_successful_deploy() {
        // Newest-first, as Jenkins returns them: the latest deploy for the PR
        // failed (nothing went live), so the previous successful one is what is
        // actually deployed.
        let builds = vec![
            JenkinsBuild {
                result: Some("FAILURE".into()),
                revision: Some("f".repeat(40)),
                ..build(3, Some("42"), Some("feat"))
            },
            JenkinsBuild {
                revision: Some("a".repeat(40)),
                ..build(2, Some("42"), Some("feat"))
            },
            JenkinsBuild {
                revision: Some("b".repeat(40)),
                ..build(1, Some("43"), Some("other"))
            },
        ];
        assert_eq!(
            deployed_revision(&builds, Some("42"), None).as_deref(),
            Some("a".repeat(40).as_str())
        );
        // No deploy for that PR at all → nothing to fall back on.
        assert_eq!(deployed_revision(&builds, Some("9999"), None), None);
        // Matching by branch works too (PR id unknown).
        assert_eq!(
            deployed_revision(&builds, None, Some("other")).as_deref(),
            Some("b".repeat(40).as_str())
        );
    }

    #[test]
    fn queue_jobs_cover_the_whole_pr_chain() {
        // A PR waits at whichever of the three chained jobs hasn't started yet;
        // missing one would show "no build" instead of "queued".
        assert!(QUEUE_JOBS.contains(&LAUNCHER_JOB));
        assert!(QUEUE_JOBS.contains(&ROUTER_JOB));
        assert!(QUEUE_JOBS.contains(&PIPELINE_JOB));
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

    /// Assemble a status for a PR with no matching Jenkins build. Safe to run
    /// offline: stages are only fetched when a pipeline build matched.
    async fn assemble_without_build(gh_verdict: Option<&str>) -> JenkinsWorktreeStatus {
        let client = JenkinsClient::new("http://127.0.0.1:1", "u", "t");
        assemble_status(
            &client,
            &[],
            &[],
            "{}",
            "wt-1",
            Some("4143"),
            Some("CU-86cahukqt-vue-exposant-readonly"),
            None,
            gh_verdict,
        )
        .await
    }

    #[tokio::test]
    async fn falls_back_to_the_github_verdict_when_jenkins_kept_no_build() {
        // The real regression: Jenkins retains ~23 builds (~6 h) on a busy
        // controller, so a PR built yesterday matches nothing and the row used
        // to render blank. GitHub still has the commit status.
        let status = assemble_without_build(Some(parse::STATUS_SUCCESS)).await;
        assert_eq!(status.overall_status, parse::STATUS_SUCCESS);
        assert_eq!(status.verdict_source, SOURCE_GITHUB);
        // No build to link to — the verdict is all we recovered.
        assert!(status.pipeline.is_none());
        assert_eq!(status.pr_id.as_deref(), Some("4143"));
    }

    #[tokio::test]
    async fn stays_unknown_when_neither_side_has_a_verdict() {
        let status = assemble_without_build(None).await;
        assert_eq!(status.overall_status, parse::STATUS_UNKNOWN);
        assert_eq!(status.verdict_source, SOURCE_NONE);

        // An empty verdict string is treated as absent, not as a fallback.
        let status = assemble_without_build(Some("")).await;
        assert_eq!(status.verdict_source, SOURCE_NONE);
    }

    #[tokio::test]
    async fn a_matched_jenkins_build_wins_over_the_github_verdict() {
        let client = JenkinsClient::new("http://127.0.0.1:1", "u", "t");
        let builds = vec![JenkinsBuild {
            result: Some("FAILURE".into()),
            ..build(7150, Some("4143"), Some("feat"))
        }];
        let status = assemble_status(
            &client,
            &builds,
            &[],
            "{}",
            "wt-1",
            Some("4143"),
            None,
            None,
            Some(parse::STATUS_SUCCESS),
        )
        .await;
        assert_eq!(status.overall_status, parse::STATUS_FAILURE);
        assert_eq!(status.verdict_source, SOURCE_JENKINS);
    }
}
