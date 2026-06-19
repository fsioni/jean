/**
 * Jenkins integration types.
 *
 * These interfaces mirror EXACTLY what the Rust backend serializes (camelCase).
 * Do not rename fields — they must match the `jenkins:status-update` event
 * payload and the `get_jenkins_status` command response.
 */

/** A single Jenkins build (pipeline run or preview deploy). */
export interface JenkinsBuild {
  number: number
  /** "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | null (still building) */
  result: string | null
  building: boolean
  timestampMs: number
  durationMs: number
  url: string
  prId: string | null
  branch: string | null
}

/** A single stage within a Jenkins pipeline build. */
export interface JenkinsStage {
  /** e.g. "Integration tests", "Unit tests" */
  name: string
  /** "SUCCESS" | "FAILED" | "IN_PROGRESS" | "NOT_EXECUTED" | "ABORTED" */
  status: string
  durationMs: number
}

/** A pending item in the Jenkins build queue (not yet a build). */
export interface JenkinsQueueItem {
  /** Why it's waiting, e.g. "Build #4,798 is already in progress". */
  why: string | null
  /** Epoch milliseconds when it entered the queue. */
  sinceMs: number
  /** Blocked (serialized behind a running build / waiting on a lock). */
  blocked: boolean
}

/** Aggregated Jenkins status for a single worktree / PR. */
export interface JenkinsWorktreeStatus {
  worktreeId: string
  prId: string | null
  /** Latest "build-and-test" build for the PR. */
  pipeline: JenkinsBuild | null
  /** Per-stage breakdown of the pipeline. */
  stages: JenkinsStage[]
  /** Latest "deploy-preview" build for the PR. */
  preview: JenkinsBuild | null
  /** e.g. "https://3959.preview.example.com/admin" */
  previewUrl: string | null
  /** Pending queue item for the PR's pipeline (waiting to start), if any. */
  queue: JenkinsQueueItem | null
  /** "BUILDING" | "QUEUED" | "SUCCESS" | "FAILURE" | "UNKNOWN" */
  overallStatus: string
  /** Epoch seconds when this status was checked. */
  checkedAt: number
}
