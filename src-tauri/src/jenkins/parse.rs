//! Pure parsing of the Jenkins REST/wfapi JSON.
//!
//! These functions take raw JSON strings (or `serde_json::Value`) and return
//! the clean types from [`super::types`]. The Jenkins `actions[]` array is
//! heterogeneous (mixes `{}` placeholders with typed action objects), so we
//! walk it as `Value` rather than deriving `Deserialize` on a brittle shape.

use super::types::{JenkinsBuild, JenkinsQueueItem, JenkinsStage};
use serde_json::Value;

/// Overall state of a worktree's pipeline build.
pub const STATUS_SUCCESS: &str = "SUCCESS";
pub const STATUS_FAILURE: &str = "FAILURE";
pub const STATUS_BUILDING: &str = "BUILDING";
pub const STATUS_QUEUED: &str = "QUEUED";
pub const STATUS_UNKNOWN: &str = "UNKNOWN";

/// A meaningful change in a job's result between two polls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// Went from green to red.
    Broke,
    /// Went from red back to green.
    Recovered,
}

/// Parse a `/job/<name>/api/json?tree=builds[...]` response into builds.
pub fn parse_builds(json: &str) -> Result<Vec<JenkinsBuild>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("Failed to parse builds JSON: {e}"))?;
    let builds = root
        .get("builds")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing `builds` array".to_string())?;
    Ok(builds.iter().filter_map(parse_build).collect())
}

/// Parse a single build object. Returns `None` if it lacks a build number.
pub fn parse_build(build: &Value) -> Option<JenkinsBuild> {
    let number = build.get("number").and_then(Value::as_u64)?;
    let params = extract_parameters(build.get("actions"));

    Some(JenkinsBuild {
        number,
        result: build
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_string),
        building: build
            .get("building")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        timestamp_ms: build.get("timestamp").and_then(Value::as_i64).unwrap_or(0),
        duration_ms: build.get("duration").and_then(Value::as_u64).unwrap_or(0),
        url: build
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pr_id: non_empty(find_param(&params, &["PR_ID", "ghprbPullId"])),
        branch: non_empty(find_param(&params, &["BRANCH", "ghprbSourceBranch"])),
        upstream_build: extract_upstream_build(build.get("actions")),
    })
}

/// The triggering upstream build number from a `CauseAction` in `actions[]`.
///
/// `integration-tests` runs are launched by the `build-and-test` pipeline, so
/// their `causes[].upstreamBuild` ties each run back to the pipeline build that
/// spawned it — the join key behind the per-attempt breakdown.
fn extract_upstream_build(actions: Option<&Value>) -> Option<u64> {
    let actions = actions.and_then(Value::as_array)?;
    for action in actions {
        let Some(causes) = action.get("causes").and_then(Value::as_array) else {
            continue;
        };
        for cause in causes {
            if let Some(n) = cause.get("upstreamBuild").and_then(Value::as_u64) {
                return Some(n);
            }
        }
    }
    None
}

/// First present value among `names`, in priority order.
///
/// Lets one [`JenkinsBuild`] model the PR/branch regardless of how the job
/// labels its parameters: the `build-and-test` pipeline carries `PR_ID` /
/// `BRANCH`, while the ghprb `*_Launcher-on-pr` entry carries `ghprbPullId` /
/// `ghprbSourceBranch`. Without this, Launcher builds parse with no PR id and
/// the re-run can never find the build to replay.
fn find_param<'a>(params: &'a [(String, String)], names: &[&str]) -> Option<&'a String> {
    names
        .iter()
        .find_map(|name| params.iter().find(|(n, _)| n == name).map(|(_, v)| v))
}

/// Collect `(name, value)` pairs from the `ParametersAction` inside `actions[]`.
pub fn extract_parameters(actions: Option<&Value>) -> Vec<(String, String)> {
    let Some(actions) = actions.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for action in actions {
        let Some(params) = action.get("parameters").and_then(Value::as_array) else {
            continue;
        };
        for param in params {
            if let (Some(name), Some(value)) = (
                param.get("name").and_then(Value::as_str),
                param.get("value").and_then(Value::as_str),
            ) {
                out.push((name.to_string(), value.to_string()));
            }
        }
    }
    out
}

/// Treat empty strings as absent.
fn non_empty(value: Option<&String>) -> Option<String> {
    value
        .filter(|v| !v.is_empty())
        .map(std::string::ToString::to_string)
}

/// Find the most recent build matching a PR number (builds are newest-first).
pub fn find_build_for_pr<'a>(builds: &'a [JenkinsBuild], pr_id: &str) -> Option<&'a JenkinsBuild> {
    if pr_id.is_empty() {
        return None;
    }
    builds.iter().find(|b| b.pr_id.as_deref() == Some(pr_id))
}

/// Parse a `wfapi/describe` response into pipeline stages.
pub fn parse_stages(json: &str) -> Result<Vec<JenkinsStage>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("Failed to parse wfapi JSON: {e}"))?;
    let stages = root
        .get("stages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing `stages` array".to_string())?;
    Ok(stages
        .iter()
        .filter_map(|stage| {
            Some(JenkinsStage {
                name: stage.get("name").and_then(Value::as_str)?.to_string(),
                status: stage
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("UNKNOWN")
                    .to_string(),
                duration_ms: stage
                    .get("durationMillis")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            })
        })
        .collect())
}

/// Find the queue item whose params reference `pr_id` for one of `jobs`.
///
/// Queue item `params` are a newline-separated `key=value` blob (different from
/// the `parameters[name,value]` array on builds). The PR is carried as `PR_ID`
/// (build-and-test) or `ghprbPullId` (the `*_Launcher-on-pr` entry).
pub fn find_queued_for_pr(json: &str, pr_id: &str, jobs: &[&str]) -> Option<JenkinsQueueItem> {
    if pr_id.is_empty() {
        return None;
    }
    let root: Value = serde_json::from_str(json).ok()?;
    let items = root.get("items")?.as_array()?;
    for item in items {
        let task_name = item
            .get("task")
            .and_then(|t| t.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !jobs.contains(&task_name) {
            continue;
        }
        let params = item
            .get("params")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if queue_params_match_pr(params, pr_id) {
            return Some(JenkinsQueueItem {
                why: item.get("why").and_then(Value::as_str).map(str::to_string),
                since_ms: item
                    .get("inQueueSince")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                blocked: item
                    .get("blocked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
    }
    None
}

/// Exact-match a PR id against `PR_ID=` / `ghprbPullId=` lines (avoids 395 ~ 3954).
fn queue_params_match_pr(params: &str, pr_id: &str) -> bool {
    params.lines().any(|line| {
        line.split_once('=')
            .is_some_and(|(key, value)| (key == "PR_ID" || key == "ghprbPullId") && value == pr_id)
    })
}

/// Aggregate, accounting for a pending queue item.
///
/// Priority: a running build (`BUILDING`) wins over a queued item (`QUEUED`),
/// which wins over the last build's verdict.
pub fn overall_status_with_queue(build: Option<&JenkinsBuild>, queued: bool) -> String {
    if matches!(build, Some(b) if b.building) {
        return STATUS_BUILDING.to_string();
    }
    if queued {
        return STATUS_QUEUED.to_string();
    }
    overall_status(build)
}

/// Aggregate a pipeline build into a single overall status string.
pub fn overall_status(build: Option<&JenkinsBuild>) -> String {
    let Some(build) = build else {
        return STATUS_UNKNOWN.to_string();
    };
    if build.building {
        return STATUS_BUILDING.to_string();
    }
    match build.result.as_deref() {
        Some(STATUS_SUCCESS) => STATUS_SUCCESS.to_string(),
        Some(_) => STATUS_FAILURE.to_string(),
        None => STATUS_UNKNOWN.to_string(),
    }
}

/// Detect a green↔red transition between the previously-seen result and a new one.
///
/// Only fires on terminal results, so it never notifies on the very first
/// observation (`prev == None`) nor while a build is still running.
pub fn detect_transition(prev: Option<&str>, new: &str) -> Option<Transition> {
    match (prev, new) {
        (Some(STATUS_SUCCESS), STATUS_FAILURE) => Some(Transition::Broke),
        (Some(STATUS_FAILURE), STATUS_SUCCESS) => Some(Transition::Recovered),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILDS_FIXTURE: &str = include_str!("tests/fixtures/build-and-test-builds.json");
    const LAUNCHER_FIXTURE: &str = include_str!("tests/fixtures/launcher-on-pr-builds.json");
    const INTEGRATION_FIXTURE: &str = include_str!("tests/fixtures/integration-tests-builds.json");
    const WFAPI_FIXTURE: &str = include_str!("tests/fixtures/wfapi-describe.json");
    const QUEUE_FIXTURE: &str = include_str!("tests/fixtures/queue.json");
    const QUEUE_JOBS: &[&str] = &["build-and-test", "build-and-test_Launcher-on-pr"];

    #[test]
    fn parses_builds_with_parameters() {
        let builds = parse_builds(BUILDS_FIXTURE).expect("parse");
        assert_eq!(builds.len(), 4);

        let latest = &builds[0];
        assert_eq!(latest.number, 6386);
        assert!(latest.building);
        assert_eq!(latest.result, None);
        assert_eq!(latest.pr_id.as_deref(), Some("3960"));
        assert_eq!(latest.branch.as_deref(), Some("feat-pagination"));
    }

    #[test]
    fn empty_pr_id_parameter_is_treated_as_absent() {
        let builds = parse_builds(BUILDS_FIXTURE).expect("parse");
        // build #6383 is a master deploy with PR_ID="".
        let master = builds.iter().find(|b| b.number == 6383).expect("6383");
        assert_eq!(master.pr_id, None);
        assert_eq!(master.branch.as_deref(), Some("master"));
        assert_eq!(master.result.as_deref(), Some("SUCCESS"));
    }

    #[test]
    fn launcher_builds_derive_pr_and_branch_from_ghprb_params() {
        // ghprb `*_Launcher-on-pr` builds carry NO PR_ID/BRANCH — the PR lives in
        // `ghprbPullId` and the branch in `ghprbSourceBranch`. parse_build must
        // surface both so the re-run can match the Launcher build to replay.
        let builds = parse_builds(LAUNCHER_FIXTURE).expect("parse launcher builds");
        assert_eq!(builds.len(), 2);

        let pr = find_build_for_pr(&builds, "3959").expect("3959 via ghprbPullId");
        assert_eq!(pr.number, 1234);
        assert_eq!(pr.pr_id.as_deref(), Some("3959"));
        assert_eq!(pr.branch.as_deref(), Some("feat-login"));
        assert_eq!(pr.result.as_deref(), Some("FAILURE"));
    }

    #[test]
    fn integration_builds_carry_their_upstream_pipeline_build() {
        // Each `integration-tests` run records the `build-and-test` build that
        // triggered it via `causes[].upstreamBuild` — the join key for attempts.
        let builds = parse_builds(INTEGRATION_FIXTURE).expect("parse integration builds");
        assert_eq!(builds.len(), 6);

        // PR 3959's pipeline (#6385) retried 3× — all three runs point back to it.
        let for_6385: Vec<u64> = builds
            .iter()
            .filter(|b| b.upstream_build == Some(6385))
            .map(|b| b.number)
            .collect();
        assert_eq!(for_6385, vec![6852, 6851, 6850]);

        // The in-flight run has no result yet but still knows its upstream build.
        let running = builds.iter().find(|b| b.number == 6854).expect("6854");
        assert!(running.building);
        assert_eq!(running.result, None);
        assert_eq!(running.upstream_build, Some(6386));
    }

    #[test]
    fn finds_latest_build_for_a_pr() {
        let builds = parse_builds(BUILDS_FIXTURE).expect("parse");
        let build = find_build_for_pr(&builds, "3959").expect("3959");
        assert_eq!(build.number, 6385);
        assert_eq!(build.result.as_deref(), Some("FAILURE"));
    }

    #[test]
    fn returns_none_for_unknown_or_empty_pr() {
        let builds = parse_builds(BUILDS_FIXTURE).expect("parse");
        assert!(find_build_for_pr(&builds, "9999").is_none());
        assert!(find_build_for_pr(&builds, "").is_none());
    }

    #[test]
    fn parses_pipeline_stages() {
        let stages = parse_stages(WFAPI_FIXTURE).expect("parse");
        assert_eq!(stages.len(), 8);

        let integration = stages
            .iter()
            .find(|s| s.name == "Integration tests")
            .expect("integration stage");
        assert_eq!(integration.status, "FAILED");
        assert!(integration.duration_ms > 0);

        let unit = stages
            .iter()
            .find(|s| s.name == "Unit tests")
            .expect("unit");
        assert_eq!(unit.status, "SUCCESS");
    }

    #[test]
    fn overall_status_reflects_build_state() {
        let building = JenkinsBuild {
            number: 1,
            result: None,
            building: true,
            timestamp_ms: 0,
            duration_ms: 0,
            url: String::new(),
            pr_id: None,
            branch: None,
            upstream_build: None,
        };
        assert_eq!(overall_status(Some(&building)), "BUILDING");

        let failed = JenkinsBuild {
            building: false,
            result: Some("FAILURE".into()),
            ..building.clone()
        };
        assert_eq!(overall_status(Some(&failed)), "FAILURE");

        let aborted = JenkinsBuild {
            result: Some("ABORTED".into()),
            ..failed.clone()
        };
        assert_eq!(overall_status(Some(&aborted)), "FAILURE");

        let success = JenkinsBuild {
            result: Some("SUCCESS".into()),
            ..failed.clone()
        };
        assert_eq!(overall_status(Some(&success)), "SUCCESS");

        assert_eq!(overall_status(None), "UNKNOWN");
    }

    #[test]
    fn finds_queued_item_for_a_pr() {
        // PR 3959 is queued in the fixture (Launcher-on-pr, serialized behind a running build).
        let item = find_queued_for_pr(QUEUE_FIXTURE, "3959", QUEUE_JOBS).expect("queued");
        assert!(item.blocked);
        assert!(item.since_ms > 0);
        assert!(item
            .why
            .as_deref()
            .unwrap_or_default()
            .contains("already in progress"));
    }

    #[test]
    fn queue_match_is_exact_not_substring() {
        // "395" must not match "3954"/"3959".
        assert!(find_queued_for_pr(QUEUE_FIXTURE, "395", QUEUE_JOBS).is_none());
        assert!(find_queued_for_pr(QUEUE_FIXTURE, "9999", QUEUE_JOBS).is_none());
        assert!(find_queued_for_pr(QUEUE_FIXTURE, "", QUEUE_JOBS).is_none());
    }

    #[test]
    fn queue_respects_job_filter() {
        // Fixture items are `build-and-test_Launcher-on-pr`; a disjoint job set finds nothing.
        assert!(find_queued_for_pr(QUEUE_FIXTURE, "3959", &["deploy-preview"]).is_none());
    }

    #[test]
    fn overall_status_prioritizes_building_then_queued() {
        let building = JenkinsBuild {
            number: 1,
            result: None,
            building: true,
            timestamp_ms: 0,
            duration_ms: 0,
            url: String::new(),
            pr_id: None,
            branch: None,
            upstream_build: None,
        };
        // Running build wins even if something is also queued.
        assert_eq!(overall_status_with_queue(Some(&building), true), "BUILDING");

        let done = JenkinsBuild {
            building: false,
            result: Some("FAILURE".into()),
            ..building.clone()
        };
        // Done build + queued new run → QUEUED (the re-run / serialization case).
        assert_eq!(overall_status_with_queue(Some(&done), true), "QUEUED");
        assert_eq!(overall_status_with_queue(Some(&done), false), "FAILURE");
        // Brand-new PR queued with no prior build → QUEUED.
        assert_eq!(overall_status_with_queue(None, true), "QUEUED");
        assert_eq!(overall_status_with_queue(None, false), "UNKNOWN");
    }

    #[test]
    fn detects_break_and_recovery_only() {
        assert_eq!(
            detect_transition(Some("SUCCESS"), "FAILURE"),
            Some(Transition::Broke)
        );
        assert_eq!(
            detect_transition(Some("FAILURE"), "SUCCESS"),
            Some(Transition::Recovered)
        );
        // First observation must not notify.
        assert_eq!(detect_transition(None, "FAILURE"), None);
        // No change → no notification.
        assert_eq!(detect_transition(Some("SUCCESS"), "SUCCESS"), None);
        assert_eq!(detect_transition(Some("FAILURE"), "FAILURE"), None);
        // Still building → no notification.
        assert_eq!(detect_transition(Some("SUCCESS"), "BUILDING"), None);
    }
}
