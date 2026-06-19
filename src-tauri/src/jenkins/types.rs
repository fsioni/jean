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
    /// Aggregated state of `pipeline`: `SUCCESS` / `FAILURE` / `BUILDING` / `UNKNOWN`.
    pub overall_status: String,
    /// Epoch seconds when this status was computed.
    pub checked_at: i64,
}
