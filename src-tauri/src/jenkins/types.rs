//! Data structures surfaced to the frontend.
//!
//! API/command data → camelCase serde (Pattern B in CLAUDE.md). The matching
//! TypeScript interfaces live in `src/types/jenkins.ts`.

use serde::Serialize;

/// One Jenkins build (a single run of a job).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JenkinsBuild {
    /// Build number (e.g. 6385).
    pub number: u64,
    /// Final result: `SUCCESS` / `FAILURE` / `UNSTABLE` / `ABORTED`. `None` while building.
    pub result: Option<String>,
    /// Whether the build is currently running.
    pub building: bool,
    /// Start time in epoch milliseconds.
    pub timestamp_ms: i64,
    /// Duration in milliseconds (0 while building).
    pub duration_ms: u64,
    /// Direct link to the build on Jenkins.
    pub url: String,
    /// `PR_ID` build parameter, when set (empty parameter → `None`).
    pub pr_id: Option<String>,
    /// `BRANCH` build parameter, when set (empty parameter → `None`).
    pub branch: Option<String>,
    /// Triggering upstream build number (from the `CauseAction`). Internal join
    /// key only — used to attribute `integration-tests` runs to their
    /// `build-and-test` build; never serialized to the frontend.
    #[serde(skip)]
    pub upstream_build: Option<u64>,
}

/// One run of the downstream `integration-tests` job for a pipeline build —
/// i.e. one retry attempt of the flaky `Integration tests` stage.
///
/// The stage retries automatically up to 3× on failure, each retry launching a
/// fresh `integration-tests` build. These surface "which try are we on" (the
/// total) plus the per-iteration build number/result to the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JenkinsAttempt {
    /// 1-based attempt index within the pipeline build ("essai N").
    pub attempt: u32,
    /// `integration-tests` job build number ("le compteur de chaque itération").
    pub number: u64,
    /// `SUCCESS` / `FAILURE` / `ABORTED`; `None` while still running.
    pub result: Option<String>,
    /// Whether this attempt is currently running.
    pub building: bool,
    /// Attempt duration in milliseconds (0 while running).
    pub duration_ms: u64,
    /// Direct link to the `integration-tests` build on Jenkins.
    pub url: String,
}

/// One stage of a declarative pipeline build (from the `wfapi/describe` view).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JenkinsStage {
    /// Stage name, e.g. `"Integration tests"`.
    pub name: String,
    /// `SUCCESS` / `FAILED` / `IN_PROGRESS` / `NOT_EXECUTED` / `ABORTED` / `PAUSED_PENDING_INPUT`.
    pub status: String,
    /// Stage duration in milliseconds.
    pub duration_ms: u64,
}

/// One failing test case from a build's JUnit report.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JenkinsFailedTest {
    /// Test class / file, e.g. `"acceptance.test_exposant"`.
    pub class_name: String,
    /// Test case name.
    pub name: String,
    /// First lines of `errorDetails`, trimmed to stay readable inline.
    pub message: Option<String>,
}

/// Why a pipeline build failed — the diagnostic Mission Control shows instead of
/// sending the user to Jenkins.
///
/// Built by drilling from the pipeline build into its first failed stage, then
/// into the downstream job that stage delegated to (Planexpo's `build-and-test`
/// mostly orchestrates `elm-tests` / `integration-tests` / AIO builds, so the
/// stage's own log only says "Starting building: elm-tests #6377").
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JenkinsFailureReport {
    /// `build-and-test` build the report was computed from.
    pub pipeline_number: u64,
    /// Name of the first failed stage, e.g. `"Elm tests"`.
    pub stage: Option<String>,
    /// Downstream job the stage delegated to, when it did (`"elm-tests"`).
    pub downstream_job: Option<String>,
    /// Downstream build number (`6377`).
    pub downstream_number: Option<u64>,
    /// Best link to open the actually-failing console on Jenkins.
    pub console_url: Option<String>,
    /// Failing test cases (capped — see `failed_test_count` for the true total).
    pub failed_tests: Vec<JenkinsFailedTest>,
    /// Total failing tests reported by Jenkins (may exceed `failed_tests.len()`).
    pub failed_test_count: u32,
    /// Cleaned tail of the failing log (pipeline noise and ANSI codes stripped).
    pub log_excerpt: String,
}

/// A pending item in the Jenkins build queue (not yet a build).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JenkinsQueueItem {
    /// Why the item is waiting, e.g. `"Build #4,798 is already in progress"`.
    pub why: Option<String>,
    /// Epoch milliseconds when the item entered the queue.
    pub since_ms: i64,
    /// Blocked (e.g. serialized behind a running build / waiting on a lock).
    pub blocked: bool,
    /// 1-based rank among the pipeline items waiting, oldest first — "2nd in
    /// line". The whole point of the global queue view: knowing whether the
    /// build is next or buried.
    pub position: u32,
    /// How many pipeline items are waiting in total (this one included).
    pub total: u32,
}

/// Aggregated Jenkins status for a single worktree's PR.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JenkinsWorktreeStatus {
    /// Worktree this status belongs to.
    pub worktree_id: String,
    /// PR number the status was resolved for, if any.
    pub pr_id: Option<String>,
    /// Latest `build-and-test` build for this PR.
    pub pipeline: Option<JenkinsBuild>,
    /// Stage breakdown of `pipeline` (unit / elm / integration / …).
    pub stages: Vec<JenkinsStage>,
    /// Retry attempts of the `Integration tests` stage for `pipeline` (the
    /// downstream `integration-tests` runs), oldest first. Empty when the build
    /// hasn't reached that stage yet.
    pub integration_attempts: Vec<JenkinsAttempt>,
    /// Latest `deploy-preview` build for this PR.
    pub preview: Option<JenkinsBuild>,
    /// Preview admin URL, e.g. `https://3959.preview.example.com/admin`.
    pub preview_url: Option<String>,
    /// Live preview freshness vs the PR head (`None` until/unless computed).
    pub preview_freshness: Option<super::freshness::PreviewFreshness>,
    /// Pending queue item for this PR's pipeline, if it's waiting to start.
    pub queue: Option<JenkinsQueueItem>,
    /// Aggregated state: `BUILDING` / `QUEUED` / `SUCCESS` / `FAILURE` / `UNKNOWN`.
    pub overall_status: String,
    /// Epoch seconds when this status was computed.
    pub checked_at: i64,
}
