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
    /// Git commit this build was built from, when resolvable (git plugin
    /// `lastBuiltRevision.SHA1` or a ghprb param). Used for preview freshness.
    pub commit_sha: Option<String>,
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
    /// Latest `deploy-preview` build for this PR.
    pub preview: Option<JenkinsBuild>,
    /// Preview admin URL, e.g. `https://3959.preview.example.com/admin`.
    pub preview_url: Option<String>,
    /// Whether the preview is up to date with the PR head (`None` until computed).
    pub preview_freshness: Option<super::freshness::PreviewFreshness>,
    /// Pending queue item for this PR's pipeline, if it's waiting to start.
    pub queue: Option<JenkinsQueueItem>,
    /// Aggregated state: `BUILDING` / `QUEUED` / `SUCCESS` / `FAILURE` / `UNKNOWN`.
    pub overall_status: String,
    /// Epoch seconds when this status was computed.
    pub checked_at: i64,
}
