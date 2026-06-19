//! Pure parsing of the Jenkins REST/wfapi JSON.
//!
//! These functions take raw JSON strings (or `serde_json::Value`) and return
//! the clean types from [`super::types`]. The Jenkins `actions[]` array is
//! heterogeneous (mixes `{}` placeholders with typed action objects), so we
//! walk it as `Value` rather than deriving `Deserialize` on a brittle shape.

use super::types::{JenkinsBuild, JenkinsStage};
use serde_json::Value;

/// Overall state of a worktree's pipeline build.
pub const STATUS_SUCCESS: &str = "SUCCESS";
pub const STATUS_FAILURE: &str = "FAILURE";
pub const STATUS_BUILDING: &str = "BUILDING";
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
        pr_id: non_empty(params.iter().find(|(n, _)| n == "PR_ID").map(|(_, v)| v)),
        branch: non_empty(params.iter().find(|(n, _)| n == "BRANCH").map(|(_, v)| v)),
    })
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
    const WFAPI_FIXTURE: &str = include_str!("tests/fixtures/wfapi-describe.json");

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
