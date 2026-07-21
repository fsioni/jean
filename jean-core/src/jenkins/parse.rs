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

// ---------------------------------------------------------------------------
// Failure diagnosis (see `JenkinsFailureReport`)
// ---------------------------------------------------------------------------

/// Max lines kept in a log excerpt, counted from the END (errors land last).
const LOG_EXCERPT_LINES: usize = 120;
/// Hard cap on the excerpt size, so a single pathological line can't blow up
/// the payload or the prompt handed to the agent.
const LOG_EXCERPT_CHARS: usize = 12_000;
/// A line this long without a single space is a base64 blob, not a message.
const BLOB_LINE_LEN: usize = 200;
/// Noise emitted by the shared pipeline library on every build.
const NOISE_PREFIXES: &[&str] = &[
    "[Pipeline]",
    "[Checks API]",
    "Slack Send Pipeline step running",
    "Recording test results",
    "Archiving artifacts",
    "Notifying upstream projects",
];

/// The first failed stage of a `wfapi/describe` response, as `(node_id, name)`.
///
/// Stages are listed in execution order, so the first FAILED one is the root
/// cause; later stages usually fail as a consequence.
pub fn find_failed_stage(json: &str) -> Option<(String, String)> {
    let root: Value = serde_json::from_str(json).ok()?;
    root.get("stages")?.as_array()?.iter().find_map(|stage| {
        if stage.get("status").and_then(Value::as_str) != Some("FAILED") {
            return None;
        }
        Some((
            stage.get("id").and_then(Value::as_str)?.to_string(),
            stage.get("name").and_then(Value::as_str)?.to_string(),
        ))
    })
}

/// The first failed step inside a stage (`stageFlowNodes`), as its node id.
pub fn find_failed_node(json: &str) -> Option<String> {
    let root: Value = serde_json::from_str(json).ok()?;
    let nodes = root.get("stageFlowNodes")?.as_array()?;
    // Prefer a failed node; fall back to the last node when the stage failed
    // without any single step being marked FAILED (e.g. a timeout).
    nodes
        .iter()
        .find(|n| n.get("status").and_then(Value::as_str) == Some("FAILED"))
        .or_else(|| nodes.last())
        .and_then(|n| n.get("id").and_then(Value::as_str))
        .map(str::to_string)
}

/// `(text, consoleUrl)` from a `wfapi/log` response.
pub fn parse_node_log(json: &str) -> (String, Option<String>) {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return (String::new(), None);
    };
    (
        root.get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        root.get("consoleUrl")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

/// The downstream build a stage delegated to, as `(job, number)`.
///
/// Planexpo's `build-and-test` mostly orchestrates other jobs, so a failing
/// stage's own log is just `Starting building: elm-tests #6377` (wrapped in
/// Jenkins link markup — call this on the HTML-stripped text).
pub fn find_downstream_build(log: &str) -> Option<(String, u64)> {
    // Scan bottom-up: the last mention is the attempt that actually failed.
    log.lines().rev().find_map(|line| {
        let rest = line
            .split_once("Starting building:")
            .or_else(|| line.split_once("Build "))
            .map(|(_, rest)| rest)?;
        let (job, after) = rest.trim().split_once('#')?;
        let number: u64 = after
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .ok()?;
        let job = job.trim();
        (!job.is_empty()).then(|| (job.to_string(), number))
    })
}

/// Strip ANSI escape sequences and Jenkins' HTML link markup from a log.
pub fn strip_log_markup(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // ANSI CSI sequence: ESC [ … <final byte>
            '\u{1b}' => {
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for c in chars.by_ref() {
                        if c.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
            }
            // HTML tag: drop it, keep the inner text.
            '<' => {
                for c in chars.by_ref() {
                    if c == '>' {
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Turn a raw Jenkins log into a readable excerpt: markup stripped, pipeline
/// noise dropped, blobs removed, tail-truncated to the last useful lines.
pub fn clean_log_excerpt(raw: &str) -> String {
    let stripped = strip_log_markup(raw);
    let mut kept: Vec<&str> = Vec::new();
    for line in stripped.lines() {
        let trimmed = line.trim_end();
        let probe = trimmed.trim_start();
        if NOISE_PREFIXES.iter().any(|p| probe.starts_with(p)) {
            continue;
        }
        if probe.len() > BLOB_LINE_LEN && !probe.contains(' ') {
            continue;
        }
        // Collapse runs of blank lines (Elm/Python traces are already spaced).
        if probe.is_empty() && kept.last().is_none_or(|l| l.trim().is_empty()) {
            continue;
        }
        kept.push(trimmed);
    }
    let start = kept.len().saturating_sub(LOG_EXCERPT_LINES);
    let excerpt = kept[start..].join("\n");
    let excerpt = excerpt.trim();

    // Char-safe tail cut (logs carry UTF-8: Elm arrows, French accents…).
    match excerpt.char_indices().rev().nth(LOG_EXCERPT_CHARS - 1) {
        Some((cut, _)) if cut > 0 => format!("…\n{}", &excerpt[cut..]),
        _ => excerpt.to_string(),
    }
}

/// Failing cases from a `testReport/api/json` response, capped at `max`.
///
/// Returns `(cases, total_failed)` — the total comes from Jenkins' own
/// `failCount` so the UI can say "3 of 27 shown".
pub fn parse_failed_tests(json: &str, max: usize) -> (Vec<super::types::JenkinsFailedTest>, u32) {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return (Vec::new(), 0);
    };
    let total = root
        .get("failCount")
        .and_then(Value::as_u64)
        .unwrap_or_default() as u32;
    let mut out = Vec::new();
    let suites = root.get("suites").and_then(Value::as_array);
    for case in suites
        .into_iter()
        .flatten()
        .filter_map(|s| s.get("cases").and_then(Value::as_array))
        .flatten()
    {
        // REGRESSION = newly failing; FAILED = still failing.
        if !matches!(
            case.get("status").and_then(Value::as_str),
            Some("FAILED" | "REGRESSION")
        ) {
            continue;
        }
        if out.len() >= max {
            break;
        }
        out.push(super::types::JenkinsFailedTest {
            class_name: case
                .get("className")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: case
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            message: failure_message(case),
        });
    }
    (out, total)
}

/// Readable failure message for a test case.
///
/// `errorDetails` is the assertion message when the runner sets one, but jest
/// leaves it null and puts everything in `errorStackTrace` (verified on
/// Planexpo's `unit-tests` #7031). Falls back to the head of the stack trace,
/// dropping the `at …` frames that carry no information inline.
fn failure_message(case: &Value) -> Option<String> {
    let details = case
        .get("errorDetails")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|d| !d.is_empty());
    if let Some(details) = details {
        return Some(truncate_chars(details, 400));
    }
    let trace = case.get("errorStackTrace").and_then(Value::as_str)?;
    let head: Vec<&str> = trace
        .lines()
        .take_while(|l| !l.trim_start().starts_with("at "))
        .collect();
    let head = head.join("\n");
    let head = head.trim();
    (!head.is_empty()).then(|| truncate_chars(head, 400))
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect::<String>() + "…"
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

    // The pipeline items waiting, oldest first — Jenkins serves them in that
    // order, so the index is the position in line.
    let mut waiting: Vec<&Value> = items
        .iter()
        .filter(|item| {
            let task = item
                .get("task")
                .and_then(|t| t.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            jobs.contains(&task)
        })
        .collect();
    waiting.sort_by_key(|item| {
        item.get("inQueueSince")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    });

    let total = waiting.len() as u32;
    let index = waiting.iter().position(|item| {
        let params = item
            .get("params")
            .and_then(Value::as_str)
            .unwrap_or_default();
        queue_params_match_pr(params, pr_id)
    })?;
    let item = waiting[index];

    Some(JenkinsQueueItem {
        why: item.get("why").and_then(Value::as_str).map(str::to_string),
        since_ms: item
            .get("inQueueSince")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        blocked: item
            .get("blocked")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        position: index as u32 + 1,
        total,
    })
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

    // Failure-diagnosis fixtures. Captured from a real controller (build
    // `build-and-test` #7139 → `elm-tests` #6377, plus a `unit-tests` JUnit
    // report with two failures) and anonymised — hosts, paths and test names
    // are neutral, the SHAPE is untouched.
    const DESCRIBE_FAILED: &str = include_str!("tests/fixtures/wfapi-describe-failed.json");
    const STAGE_NODE_FAILED: &str = include_str!("tests/fixtures/wfapi-stage-node-failed.json");
    const NODE_LOG: &str = include_str!("tests/fixtures/wfapi-node-log.json");
    const CONSOLE_LOG: &str = include_str!("tests/fixtures/elm-tests-console.txt");
    const TEST_REPORT: &str = include_str!("tests/fixtures/test-report-failed.json");

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

    #[test]
    fn queue_reports_the_position_in_line_oldest_first() {
        // Two PRs waiting on the serialized pipeline: the one that entered the
        // queue first is 1/2, the other 2/2.
        let json = r#"{"items":[
            {"task":{"name":"build-and-test"},"params":"\nPR_ID=200\n","inQueueSince":2000},
            {"task":{"name":"build-and-test"},"params":"\nPR_ID=100\n","inQueueSince":1000},
            {"task":{"name":"some-other-job"},"params":"\nPR_ID=300\n","inQueueSince":500}
        ]}"#;
        let first = find_queued_for_pr(json, "100", QUEUE_JOBS).expect("100 queued");
        assert_eq!((first.position, first.total), (1, 2));
        let second = find_queued_for_pr(json, "200", QUEUE_JOBS).expect("200 queued");
        assert_eq!((second.position, second.total), (2, 2));
        // Jobs outside the pipeline never count toward the line.
        assert_eq!(find_queued_for_pr(json, "300", QUEUE_JOBS), None);
    }

    // -- Failure diagnosis ---------------------------------------------------

    #[test]
    fn finds_the_first_failed_stage_not_the_cascade() {
        // #7139 fails from "Elm tests" onwards; every later stage fails as a
        // consequence. The report must point at the root cause.
        let (node_id, name) = find_failed_stage(DESCRIBE_FAILED).expect("a failed stage");
        assert_eq!(name, "Elm tests");
        assert_eq!(node_id, "25");
    }

    #[test]
    fn no_failed_stage_on_a_green_build() {
        assert_eq!(find_failed_stage(BUILDS_FIXTURE), None); // wrong shape → None
        let green = r#"{"stages":[{"id":"4","name":"Unit tests","status":"SUCCESS"}]}"#;
        assert_eq!(find_failed_stage(green), None);
    }

    #[test]
    fn finds_the_failing_step_inside_a_stage() {
        assert_eq!(find_failed_node(STAGE_NODE_FAILED).as_deref(), Some("28"));
    }

    #[test]
    fn falls_back_to_the_last_step_when_none_is_marked_failed() {
        // Timeouts abort the stage without flagging an individual step.
        let json = r#"{"stageFlowNodes":[
            {"id":"10","status":"SUCCESS"},
            {"id":"11","status":"ABORTED"}
        ]}"#;
        assert_eq!(find_failed_node(json).as_deref(), Some("11"));
    }

    #[test]
    fn reads_text_and_console_url_from_a_step_log() {
        let (text, console) = parse_node_log(NODE_LOG);
        assert!(text.contains("Starting building:"));
        assert_eq!(
            console.as_deref(),
            Some("/job/build-and-test/7139/execution/node/28/log")
        );
    }

    #[test]
    fn follows_the_downstream_build_a_stage_delegates_to() {
        // The stage log is pure Jenkins link markup; the real output lives in
        // the downstream job it scheduled.
        let (text, _) = parse_node_log(NODE_LOG);
        let plain = strip_log_markup(&text);
        assert_eq!(
            find_downstream_build(&plain),
            Some(("elm-tests".to_string(), 6377))
        );
    }

    #[test]
    fn no_downstream_build_when_the_stage_ran_its_own_steps() {
        assert_eq!(find_downstream_build("+ yarn test\nFAILED 3 specs"), None);
    }

    #[test]
    fn strips_ansi_codes_and_jenkins_link_markup() {
        let raw = "\u{1b}[31mBuild <a href='/job/x/1/' class='link'>x #1</a> completed\u{1b}[0m";
        assert_eq!(strip_log_markup(raw), "Build x #1 completed");
        assert_eq!(strip_log_markup("a &lt;b&gt; &amp; c"), "a <b> & c");
    }

    #[test]
    fn log_excerpt_keeps_the_error_and_drops_the_noise() {
        let excerpt = clean_log_excerpt(CONSOLE_LOG);
        // The actual compiler error survives…
        assert!(excerpt.contains("TYPE MISMATCH"));
        assert!(excerpt.contains("`elm make` failed with exit code 1."));
        // …while the per-build pipeline chatter is gone.
        assert!(!excerpt.contains("[Pipeline]"));
        assert!(!excerpt.contains("Slack Send Pipeline step running"));
        assert!(!excerpt.contains("Recording test results"));
    }

    #[test]
    fn log_excerpt_drops_base64_blobs_and_caps_length() {
        let blob = "x".repeat(400);
        let raw = format!("keep me\n{blob}\nkeep me too");
        let excerpt = clean_log_excerpt(&raw);
        assert_eq!(excerpt, "keep me\nkeep me too");

        let huge = (0..4000)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let excerpt = clean_log_excerpt(&huge);
        assert!(excerpt.chars().count() <= LOG_EXCERPT_CHARS + 2);
        // Truncation keeps the TAIL — that's where failures are reported.
        assert!(excerpt.ends_with("line 3999"));
    }

    #[test]
    fn parses_failing_tests_with_the_jest_stack_trace_fallback() {
        let (tests, total) = parse_failed_tests(TEST_REPORT, 15);
        assert_eq!(total, 2);
        assert_eq!(tests.len(), 2);
        assert!(tests.iter().all(|t| !t.name.is_empty()));
        // jest leaves `errorDetails` null: the message comes from the head of
        // the stack trace, with the `at …` frames stripped.
        let message = tests[0].message.as_deref().expect("a failure message");
        assert!(message.contains("Exceeded timeout of 5000 ms"));
        assert!(!message.contains("\n    at "));
    }

    #[test]
    fn failing_tests_are_capped_but_the_total_is_not() {
        let (tests, total) = parse_failed_tests(TEST_REPORT, 1);
        assert_eq!(tests.len(), 1);
        assert_eq!(total, 2);
    }

    #[test]
    fn passing_cases_are_never_reported_as_failures() {
        let (tests, _) = parse_failed_tests(TEST_REPORT, 15);
        assert!(tests.iter().all(|t| t.name.contains("WidgetRepoMongo")));
    }
}
