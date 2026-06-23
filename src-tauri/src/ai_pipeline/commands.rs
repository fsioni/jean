//! Tauri commands for the AI pipeline PR lifecycle.
//!
//! Phase 1 (resume): list pipeline PRs scoped to the project's GitHub repo,
//! create a worktree from one, and self-assign on both the ClickUp task and the
//! GitHub PR (guarded — refuses if already assigned to someone else).
//!
//! Phase 2 (finish): one action = ClickUp status → `to deploy` + merge the PR.
//!
//! Everything reuses existing building blocks: `checkout_pr`, `merge_github_pr`,
//! the ClickUp commands, `parse_clickup_task_id_from_branch`, and
//! `git::get_github_url`. The only new GitHub plumbing is `gh pr edit
//! --add-assignee @me` (with a `gh pr view` pre-check).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::AppHandle;

use super::client::fetch_prs;
use super::config::{load_ai_pipeline_config, resolve_dashboard_url};
use crate::gh_cli::config::resolve_gh_binary;
use crate::platform::silent_command;
use crate::projects::clickup_client::clickup_get;
use crate::projects::git::get_github_url;
use crate::projects::storage::load_projects_data;
use crate::projects::types::Worktree;
use crate::projects::{
    assign_clickup_task_to_me, checkout_pr, get_clickup_me, get_clickup_task, load_clickup_config,
    merge_github_pr, parse_clickup_task_id_from_branch, resolve_clickup_token,
    update_clickup_task_status, ClickUpTask,
};

/// ClickUp statuses that mark a ticket ready to pick up for review/merge.
/// Both the queued (`to review`) and active (`in review`) review columns count.
const REVIEW_STATUSES: &[&str] = &["to review", "in review"];

/// ClickUp status the "finish" action moves the task to.
const TO_DEPLOY_STATUS: &str = "to deploy";

// =============================================================================
// Types (camelCase for the frontend)
// =============================================================================

/// A pipeline PR surfaced from the dashboard `/prs` endpoint, scoped to one repo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiPipelinePr {
    pub number: u32,
    pub title: String,
    pub branch: String,
    pub url: String,
    /// CI rollup: `SUCCESS` | `FAILURE` | `PENDING` (or absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ci: Option<String>,
    pub is_draft: bool,
    /// `MERGEABLE` | `CONFLICTING` | `UNKNOWN` (or absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mergeable: Option<String>,
    pub created_at: String,
    pub labels: Vec<String>,
    /// GitHub `owner/repo` slug this PR belongs to.
    pub repo_slug: String,
    /// ClickUp task id derived from the `CU-<id>` branch convention, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clickup_task_id: Option<String>,
}

/// A ClickUp `TO REVIEW` ticket ready to pick up (unassigned or mine), joined
/// with its GitHub PR in the current project's repo. ClickUp drives the list
/// (source of truth for status + assignment); the PR carries the resume target
/// and its CI/draft/mergeable state (which may legitimately be red/draft).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiPipelineReviewTask {
    pub task_id: String,
    pub name: String,
    /// ClickUp status name (e.g. `to review`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// `true` when the ticket is already assigned to me, `false` when it is
    /// unassigned (free to grab).
    pub assigned_to_me: bool,
    /// ClickUp task URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The matching pipeline PR in this repo (resume target).
    pub pr: AiPipelinePr,
}

/// Outcome of one best-effort sub-step (so a partial success is still reported).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub ok: bool,
    pub message: String,
}

impl StepResult {
    fn ok(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: message.into(),
        }
    }

    fn fail(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
        }
    }
}

/// Result of resuming a pipeline PR: the worktree (always created on success),
/// plus the per-side self-assign outcomes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResult {
    pub worktree: Worktree,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clickup_task_id: Option<String>,
    pub github: StepResult,
    pub clickup: StepResult,
}

/// Result of finishing a pipeline PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishResult {
    pub clickup: StepResult,
    pub merge: StepResult,
}

// =============================================================================
// Pure helpers (unit-tested without disk/network)
// =============================================================================

/// Extract the `owner/repo` slug from a normalized GitHub URL.
fn repo_slug_from_github_url(url: &str) -> Option<String> {
    url.strip_prefix("https://github.com/")
        .map(|s| s.trim_end_matches('/').trim_end_matches(".git").to_string())
        .filter(|s| !s.is_empty())
}

/// Parse the dashboard `/prs` payload into the pipeline PRs of one repo.
///
/// A PR is "pipeline" when its branch follows the `CU-<id>` convention (the
/// reliable signal — the label is added late by review steps) **or** it carries
/// the configured pipeline `label`. When `repo_slug_filter` is set, only that
/// repo's PRs are returned (case-insensitive slug match).
fn parse_pipeline_prs(
    value: &serde_json::Value,
    repo_slug_filter: Option<&str>,
    label: &str,
) -> Vec<AiPipelinePr> {
    let mut out = Vec::new();
    let Some(repos) = value.get("repos").and_then(|r| r.as_object()) else {
        return out;
    };

    for repo in repos.values() {
        let slug = repo
            .get("slug")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(filter) = repo_slug_filter {
            if !slug.eq_ignore_ascii_case(filter) {
                continue;
            }
        }

        let Some(prs) = repo.get("prs").and_then(|p| p.as_array()) else {
            continue;
        };

        for pr in prs {
            let Some(number) = pr.get("number").and_then(|n| n.as_u64()) else {
                continue;
            };
            let branch = pr
                .get("branch")
                .and_then(|b| b.as_str())
                .unwrap_or("")
                .to_string();
            let labels: Vec<String> = pr
                .get("labels")
                .and_then(|l| l.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            let clickup_task_id = parse_clickup_task_id_from_branch(&branch);
            let is_pipeline = clickup_task_id.is_some() || labels.iter().any(|l| l == label);
            if !is_pipeline {
                continue;
            }

            out.push(AiPipelinePr {
                number: number as u32,
                title: pr
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
                branch,
                url: pr
                    .get("url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string(),
                ci: pr.get("ci").and_then(|c| c.as_str()).map(String::from),
                is_draft: pr.get("isDraft").and_then(|d| d.as_bool()).unwrap_or(false),
                mergeable: pr
                    .get("mergeable")
                    .and_then(|m| m.as_str())
                    .map(String::from),
                created_at: pr
                    .get("created_at")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                labels,
                repo_slug: slug.clone(),
                clickup_task_id,
            });
        }
    }

    // Newest first (ISO-8601 timestamps sort lexicographically).
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Review-status + (unassigned OR mine) inclusion filter. Pure so it is
/// unit-tested. Returns `Some(assigned_to_me)` when the ticket should be shown,
/// `None` when it must be excluded (wrong status or owned by someone else).
fn review_inclusion(status: Option<&str>, assignee_ids: &[i64], me_id: i64) -> Option<bool> {
    let is_review = status
        .map(|s| REVIEW_STATUSES.iter().any(|r| s.eq_ignore_ascii_case(r)))
        .unwrap_or(false);
    if !is_review {
        return None;
    }
    let assigned_to_me = assignee_ids.contains(&me_id);
    let unassigned = assignee_ids.is_empty();
    if assigned_to_me || unassigned {
        Some(assigned_to_me)
    } else {
        None
    }
}

/// Decide whether the current user may self-assign given the existing assignee
/// logins. Pure so the guard logic is unit-tested. Returns the action message on
/// allow, or an error message when the PR is owned by someone else.
fn github_assign_decision(me: &str, assignees: &[String]) -> Result<GithubAssign, String> {
    if assignees.iter().any(|a| a.eq_ignore_ascii_case(me)) {
        return Ok(GithubAssign::AlreadyMine);
    }
    if !assignees.is_empty() {
        return Err(format!("PR déjà assignée à {}", assignees.join(", ")));
    }
    Ok(GithubAssign::Assign)
}

#[derive(Debug, PartialEq)]
enum GithubAssign {
    AlreadyMine,
    Assign,
}

// =============================================================================
// Internal (disk/network) helpers
// =============================================================================

fn project_path_for(app: &AppHandle, project_id: &str) -> Result<String, String> {
    let data = load_projects_data(app)?;
    data.find_project(project_id)
        .map(|p| p.path.clone())
        .ok_or_else(|| format!("Project not found: {project_id}"))
}

fn repo_slug_for_path(project_path: &str) -> Result<String, String> {
    let url = get_github_url(project_path)?;
    repo_slug_from_github_url(&url)
        .ok_or_else(|| format!("Could not parse owner/repo from GitHub URL: {url}"))
}

/// Current GitHub login from `gh api user`.
fn gh_login(app: &AppHandle) -> Result<String, String> {
    let gh = resolve_gh_binary(app);
    let output = silent_command(&gh)
        .args(["api", "user", "--jq", ".login"])
        .output()
        .map_err(|e| format!("Failed to run gh api user: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh api user failed: {stderr}"));
    }
    let login = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if login.is_empty() {
        return Err("gh api user returned an empty login".to_string());
    }
    Ok(login)
}

/// Read the PR's current assignee logins via `gh pr view`.
fn gh_pr_assignees(
    app: &AppHandle,
    repo_slug: &str,
    pr_number: u32,
) -> Result<Vec<String>, String> {
    let gh = resolve_gh_binary(app);
    let output = silent_command(&gh)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--repo",
            repo_slug,
            "--json",
            "assignees",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr view: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr view failed: {stderr}"));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse gh pr view output: {e}"))?;
    let assignees = value
        .get("assignees")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.get("login").and_then(|l| l.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(assignees)
}

/// Self-assign the PR via `gh pr edit --add-assignee @me`, guarded against
/// stealing a PR already assigned to someone else. Returns a human message.
fn assign_pr_guarded(app: &AppHandle, repo_slug: &str, pr_number: u32) -> Result<String, String> {
    let me = gh_login(app)?;
    let assignees = gh_pr_assignees(app, repo_slug, pr_number)?;

    match github_assign_decision(&me, &assignees)? {
        GithubAssign::AlreadyMine => Ok("PR déjà assignée à toi".to_string()),
        GithubAssign::Assign => {
            let gh = resolve_gh_binary(app);
            let output = silent_command(&gh)
                .args([
                    "pr",
                    "edit",
                    &pr_number.to_string(),
                    "--repo",
                    repo_slug,
                    "--add-assignee",
                    "@me",
                ])
                .output()
                .map_err(|e| format!("Failed to run gh pr edit: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("gh pr edit failed: {stderr}"));
            }
            Ok("PR auto-assignée".to_string())
        }
    }
}

/// Self-assign the ClickUp task, guarded against stealing a task already
/// assigned to someone else. Returns a human message.
async fn assign_clickup_guarded(
    app: &AppHandle,
    task_id: &str,
    project_id: &str,
) -> Result<String, String> {
    let me = get_clickup_me(app.clone(), Some(project_id.to_string())).await?;
    let task = get_clickup_task(
        app.clone(),
        task_id.to_string(),
        Some(project_id.to_string()),
    )
    .await?;

    let mine = task.assignees.iter().any(|a| a.id == me.id);
    if mine {
        return Ok("Tâche déjà assignée à toi".to_string());
    }
    if !task.assignees.is_empty() {
        let others: Vec<String> = task
            .assignees
            .iter()
            .map(|a| a.username.clone().unwrap_or_else(|| a.id.to_string()))
            .collect();
        return Err(format!("Tâche déjà assignée à {}", others.join(", ")));
    }

    assign_clickup_task_to_me(
        app.clone(),
        task_id.to_string(),
        Some(project_id.to_string()),
    )
    .await?;
    Ok("Tâche auto-assignée".to_string())
}

/// Fetch the `TO REVIEW` ClickUp tickets from every configured list (Planexpo +
/// Sprint), deduped by id. Uses the API status filter and a client-side guard.
async fn fetch_review_tasks(app: &AppHandle, project_id: &str) -> Result<Vec<ClickUpTask>, String> {
    let token = resolve_clickup_token(app, Some(project_id))?;
    let config = load_clickup_config(app)?;

    let lists: Vec<String> = [config.planexpo_list_id, config.sprint_list_id]
        .into_iter()
        .flatten()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lists.is_empty() {
        return Err(
            "No ClickUp list configured. Set a list id in Settings → Integrations.".to_string(),
        );
    }

    // Resilient: a misconfigured list (e.g. a workspace id pasted as a list id →
    // 404) must not blank the whole feature. Skip failing lists and continue;
    // only surface an error when *every* configured list failed (e.g. bad token).
    let mut seen = HashSet::new();
    let mut tasks = Vec::new();
    let mut any_ok = false;
    let mut last_err: Option<String> = None;
    for list_id in lists {
        // Narrow the payload to the review columns; brackets/space url-encoded.
        let path = format!(
            "/list/{list_id}/task?statuses%5B%5D=to%20review&statuses%5B%5D=in%20review&include_closed=false"
        );
        match clickup_get(&token, &path).await {
            Ok(value) => {
                any_ok = true;
                if let Some(arr) = value.get("tasks").and_then(|t| t.as_array()) {
                    for raw in arr {
                        if let Ok(task) = serde_json::from_value::<ClickUpTask>(raw.clone()) {
                            if seen.insert(task.id.clone()) {
                                tasks.push(task);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!("AI pipeline: skipping ClickUp list {list_id}: {e}");
                last_err = Some(e);
            }
        }
    }
    if !any_ok {
        if let Some(e) = last_err {
            return Err(e);
        }
    }
    Ok(tasks)
}

// =============================================================================
// Tauri commands
// =============================================================================

/// List the AI pipeline PRs for a project (scoped to its GitHub repo).
#[tauri::command]
pub async fn list_ai_pipeline_prs(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<AiPipelinePr>, String> {
    let config = load_ai_pipeline_config(&app)?;
    let base = resolve_dashboard_url(&config)?;
    let label = config.effective_label();

    let project_path = project_path_for(&app, &project_id)?;
    let slug = repo_slug_for_path(&project_path)?;

    let value = fetch_prs(&base).await?;
    Ok(parse_pipeline_prs(&value, Some(&slug), &label))
}

/// List the ClickUp `TO REVIEW` tickets ready to pick up (unassigned or mine),
/// joined with their PR in this project's repo.
///
/// ClickUp is the source of truth: a ticket shows whatever its PR's CI/draft
/// state is (red CI / draft PRs are expected in review). Tickets whose PR is in
/// another repo — or that have no PR yet — are not shown in this project's modal.
#[tauri::command]
pub async fn list_ai_pipeline_review_tasks(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<AiPipelineReviewTask>, String> {
    // This repo's pipeline PRs, keyed by their ClickUp task id (for the join).
    let config = load_ai_pipeline_config(&app)?;
    let base = resolve_dashboard_url(&config)?;
    let label = config.effective_label();
    let project_path = project_path_for(&app, &project_id)?;
    let slug = repo_slug_for_path(&project_path)?;
    let value = fetch_prs(&base).await?;
    let pr_by_task: HashMap<String, AiPipelinePr> = parse_pipeline_prs(&value, Some(&slug), &label)
        .into_iter()
        .filter_map(|pr| pr.clickup_task_id.clone().map(|id| (id, pr)))
        .collect();

    // ClickUp TO-REVIEW tickets + the current user (assignment filter).
    let me = get_clickup_me(app.clone(), Some(project_id.clone())).await?;
    let tasks = fetch_review_tasks(&app, &project_id).await?;

    let mut items: Vec<AiPipelineReviewTask> = Vec::new();
    for task in tasks {
        let assignee_ids: Vec<i64> = task.assignees.iter().map(|a| a.id).collect();
        let status = task.status.as_ref().map(|s| s.status.as_str());
        let Some(assigned_to_me) = review_inclusion(status, &assignee_ids, me.id) else {
            continue;
        };
        // Repo scoping + resume target: keep only tickets whose PR is in this repo.
        let Some(pr) = pr_by_task.get(&task.id).cloned() else {
            continue;
        };
        items.push(AiPipelineReviewTask {
            task_id: task.id.clone(),
            name: task.name.clone(),
            status: task.status.as_ref().map(|s| s.status.clone()),
            assigned_to_me,
            url: task.url.clone(),
            pr,
        });
    }

    // Mine first, then newest PR first.
    items.sort_by(|a, b| {
        b.assigned_to_me
            .cmp(&a.assigned_to_me)
            .then(b.pr.created_at.cmp(&a.pr.created_at))
    });
    Ok(items)
}

/// Self-assign the GitHub PR to the current user (guarded). Standalone command;
/// `resume_ai_pipeline_pr` performs this as part of its flow.
#[tauri::command]
pub async fn assign_pr_to_me(
    app: AppHandle,
    project_id: String,
    pr_number: u32,
) -> Result<StepResult, String> {
    let project_path = project_path_for(&app, &project_id)?;
    let slug = repo_slug_for_path(&project_path)?;
    Ok(match assign_pr_guarded(&app, &slug, pr_number) {
        Ok(m) => StepResult::ok(m),
        Err(e) => StepResult::fail(e),
    })
}

/// Resume a pipeline PR: create a worktree from it, then self-assign on both the
/// GitHub PR and the linked ClickUp task. The worktree creation must succeed;
/// the two self-assign steps are best-effort and reported individually.
#[tauri::command]
pub async fn resume_ai_pipeline_pr(
    app: AppHandle,
    project_id: String,
    pr_number: u32,
) -> Result<ResumeResult, String> {
    let project_path = project_path_for(&app, &project_id)?;
    let slug = repo_slug_for_path(&project_path)?;

    // 1. Worktree from the PR (hard requirement).
    let worktree = checkout_pr(app.clone(), project_id.clone(), pr_number).await?;

    // 2. GitHub self-assign (best effort).
    let github = match assign_pr_guarded(&app, &slug, pr_number) {
        Ok(m) => StepResult::ok(m),
        Err(e) => StepResult::fail(e),
    };

    // 3. ClickUp self-assign (best effort), task id from the branch convention.
    let clickup_task_id = parse_clickup_task_id_from_branch(&worktree.branch);
    let clickup = match &clickup_task_id {
        Some(id) => match assign_clickup_guarded(&app, id, &project_id).await {
            Ok(m) => StepResult::ok(m),
            Err(e) => StepResult::fail(e),
        },
        None => StepResult::fail("Aucune tâche ClickUp liée à la branche"),
    };

    Ok(ResumeResult {
        worktree,
        clickup_task_id,
        github,
        clickup,
    })
}

/// Finish a pipeline PR in one action: move the ClickUp task to `to deploy` and
/// merge the PR. Both steps are reported individually.
#[tauri::command]
pub async fn finish_ai_pipeline_pr(
    app: AppHandle,
    worktree_path: String,
    project_id: String,
    task_id: Option<String>,
) -> Result<FinishResult, String> {
    // 1. ClickUp → TO DEPLOY (skipped with a message when no task is linked).
    let clickup = match &task_id {
        Some(id) => match update_clickup_task_status(
            app.clone(),
            id.clone(),
            TO_DEPLOY_STATUS.to_string(),
            Some(project_id.clone()),
        )
        .await
        {
            Ok(_) => StepResult::ok("Tâche → TO DEPLOY"),
            Err(e) => StepResult::fail(e),
        },
        None => StepResult::fail("Aucune tâche ClickUp liée"),
    };

    // 2. Merge the PR.
    let merge = match merge_github_pr(app.clone(), worktree_path).await {
        Ok(r) => StepResult::ok(r.message),
        Err(e) => StepResult::fail(e),
    };

    Ok(FinishResult { clickup, merge })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload() -> serde_json::Value {
        serde_json::json!({
            "generated_at": "2026-06-22T14:35:01Z",
            "repos": {
                "planexpo": {
                    "slug": "Spottt/planexpo",
                    "prs": [
                        {
                            "number": 3977,
                            "title": "feat(86c997enp): identifiant national",
                            "branch": "CU-86c997enp__national-id",
                            "url": "https://github.com/Spottt/planexpo/pull/3977",
                            "ci": "FAILURE",
                            "isDraft": true,
                            "mergeable": "UNKNOWN",
                            "created_at": "2026-06-22T13:54:26Z",
                            "labels": []
                        },
                        {
                            "number": 3976,
                            "title": "feat(86cac8hvh): Emailing 2eme passe",
                            "branch": "CU-86cac8hvh-emailing-2eme-passe",
                            "url": "https://github.com/Spottt/planexpo/pull/3976",
                            "ci": "SUCCESS",
                            "isDraft": true,
                            "mergeable": "MERGEABLE",
                            "created_at": "2026-06-22T11:25:25Z",
                            "labels": ["ai-full-flow"]
                        },
                        {
                            "number": 100,
                            "title": "chore: human PR not from pipeline",
                            "branch": "fix/manual-tweak",
                            "url": "https://github.com/Spottt/planexpo/pull/100",
                            "ci": "SUCCESS",
                            "isDraft": false,
                            "mergeable": "MERGEABLE",
                            "created_at": "2026-06-10T09:00:00Z",
                            "labels": []
                        },
                        {
                            "number": 101,
                            "title": "feat: labeled but no CU branch",
                            "branch": "feature/labeled",
                            "url": "https://github.com/Spottt/planexpo/pull/101",
                            "ci": "PENDING",
                            "isDraft": false,
                            "mergeable": "MERGEABLE",
                            "created_at": "2026-06-09T09:00:00Z",
                            "labels": ["ai-full-flow"]
                        }
                    ]
                },
                "myb": {
                    "slug": "Spottt/myb",
                    "prs": [
                        {
                            "number": 50,
                            "title": "feat(abc123): other repo",
                            "branch": "CU-abc123-thing",
                            "url": "https://github.com/Spottt/myb/pull/50",
                            "ci": "SUCCESS",
                            "isDraft": false,
                            "mergeable": "MERGEABLE",
                            "created_at": "2026-06-20T09:00:00Z",
                            "labels": []
                        }
                    ]
                }
            }
        })
    }

    #[test]
    fn filters_to_requested_repo() {
        let prs = parse_pipeline_prs(&sample_payload(), Some("Spottt/planexpo"), "ai-full-flow");
        assert!(prs.iter().all(|p| p.repo_slug == "Spottt/planexpo"));
        assert!(!prs.iter().any(|p| p.number == 50)); // myb excluded
    }

    #[test]
    fn repo_filter_is_case_insensitive() {
        let prs = parse_pipeline_prs(&sample_payload(), Some("spottt/PLANEXPO"), "ai-full-flow");
        assert!(prs.iter().any(|p| p.number == 3977));
    }

    #[test]
    fn includes_cu_branch_even_without_label() {
        let prs = parse_pipeline_prs(&sample_payload(), Some("Spottt/planexpo"), "ai-full-flow");
        let pr = prs
            .iter()
            .find(|p| p.number == 3977)
            .expect("CU PR present");
        assert_eq!(pr.clickup_task_id.as_deref(), Some("86c997enp"));
        assert!(pr.labels.is_empty());
    }

    #[test]
    fn includes_labeled_pr_without_cu_branch() {
        let prs = parse_pipeline_prs(&sample_payload(), Some("Spottt/planexpo"), "ai-full-flow");
        let pr = prs
            .iter()
            .find(|p| p.number == 101)
            .expect("labeled PR present");
        assert!(pr.clickup_task_id.is_none());
    }

    #[test]
    fn excludes_human_pr_without_label_or_cu_branch() {
        let prs = parse_pipeline_prs(&sample_payload(), Some("Spottt/planexpo"), "ai-full-flow");
        assert!(!prs.iter().any(|p| p.number == 100));
    }

    #[test]
    fn sorted_newest_first() {
        let prs = parse_pipeline_prs(&sample_payload(), Some("Spottt/planexpo"), "ai-full-flow");
        let dates: Vec<&str> = prs.iter().map(|p| p.created_at.as_str()).collect();
        let mut sorted = dates.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(dates, sorted);
    }

    #[test]
    fn maps_pr_fields() {
        let prs = parse_pipeline_prs(&sample_payload(), Some("Spottt/planexpo"), "ai-full-flow");
        let pr = prs.iter().find(|p| p.number == 3976).unwrap();
        assert_eq!(pr.ci.as_deref(), Some("SUCCESS"));
        assert!(pr.is_draft);
        assert_eq!(pr.mergeable.as_deref(), Some("MERGEABLE"));
        assert_eq!(pr.clickup_task_id.as_deref(), Some("86cac8hvh"));
    }

    #[test]
    fn no_repo_filter_returns_all_repos() {
        let prs = parse_pipeline_prs(&sample_payload(), None, "ai-full-flow");
        assert!(prs.iter().any(|p| p.repo_slug == "Spottt/myb"));
        assert!(prs.iter().any(|p| p.repo_slug == "Spottt/planexpo"));
    }

    #[test]
    fn empty_payload_yields_no_prs() {
        let prs = parse_pipeline_prs(&serde_json::json!({}), None, "ai-full-flow");
        assert!(prs.is_empty());
    }

    #[test]
    fn slug_parsed_from_github_url() {
        assert_eq!(
            repo_slug_from_github_url("https://github.com/Spottt/planexpo"),
            Some("Spottt/planexpo".to_string())
        );
        assert_eq!(
            repo_slug_from_github_url("https://github.com/Spottt/planexpo.git"),
            Some("Spottt/planexpo".to_string())
        );
        assert_eq!(repo_slug_from_github_url("https://gitlab.com/x/y"), None);
    }

    #[test]
    fn github_guard_allows_when_unassigned() {
        assert_eq!(
            github_assign_decision("fares", &[]),
            Ok(GithubAssign::Assign)
        );
    }

    #[test]
    fn github_guard_idempotent_when_already_mine() {
        assert_eq!(
            github_assign_decision("fares", &["fares".to_string()]),
            Ok(GithubAssign::AlreadyMine)
        );
        // case-insensitive
        assert_eq!(
            github_assign_decision("Fares", &["fares".to_string()]),
            Ok(GithubAssign::AlreadyMine)
        );
    }

    #[test]
    fn github_guard_blocks_when_assigned_to_other() {
        let decision = github_assign_decision("fares", &["someone-else".to_string()]);
        assert!(decision.is_err());
    }

    #[test]
    fn github_guard_allows_when_mine_among_others() {
        assert_eq!(
            github_assign_decision("fares", &["other".to_string(), "fares".to_string()]),
            Ok(GithubAssign::AlreadyMine)
        );
    }

    #[test]
    fn review_includes_unassigned_review_columns() {
        assert_eq!(review_inclusion(Some("to review"), &[], 7), Some(false));
        assert_eq!(review_inclusion(Some("in review"), &[], 7), Some(false));
    }

    #[test]
    fn review_includes_when_assigned_to_me() {
        assert_eq!(review_inclusion(Some("to review"), &[7], 7), Some(true));
        assert_eq!(review_inclusion(Some("in review"), &[7], 7), Some(true));
        // mine among others
        assert_eq!(review_inclusion(Some("to review"), &[3, 7], 7), Some(true));
    }

    #[test]
    fn review_excludes_when_assigned_to_other() {
        assert_eq!(review_inclusion(Some("to review"), &[3], 7), None);
        assert_eq!(review_inclusion(Some("in review"), &[3], 7), None);
    }

    #[test]
    fn review_excludes_non_review_status() {
        assert_eq!(review_inclusion(Some("in progress"), &[7], 7), None);
        assert_eq!(review_inclusion(Some("to deploy"), &[], 7), None);
        assert_eq!(review_inclusion(None, &[], 7), None);
    }

    #[test]
    fn review_status_is_case_insensitive() {
        assert_eq!(review_inclusion(Some("TO REVIEW"), &[], 7), Some(false));
        assert_eq!(review_inclusion(Some("In Review"), &[], 7), Some(false));
    }
}
