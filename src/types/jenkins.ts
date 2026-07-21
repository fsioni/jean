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

/**
 * Whether the live PR preview is up to date with the PR head.
 *
 * Resolved by probing the preview's `/version` endpoint (first line
 * `commit <sha>`) and comparing the deployed commit to the PR's GitHub head
 * (headRefOid).
 */
export interface PreviewFreshness {
  /** "UP_TO_DATE" | "STALE" | "DOWN" | "UNKNOWN" */
  status: string
  /** Commit the preview is actually serving (from `/version`). */
  previewSha: string | null
  /** Current PR head commit (headRefOid). */
  prHeadSha: string | null
  /** How many commits the PR head is ahead of the preview (best-effort). */
  behindBy: number | null
}

/** A single stage within a Jenkins pipeline build. */
export interface JenkinsStage {
  /** e.g. "Integration tests", "Unit tests" */
  name: string
  /** "SUCCESS" | "FAILED" | "IN_PROGRESS" | "NOT_EXECUTED" | "ABORTED" */
  status: string
  durationMs: number
}

/**
 * One run (retry attempt) of the downstream `integration-tests` job for a
 * pipeline build.
 *
 * The flaky "Integration tests" stage auto-retries up to 3× on failure, each
 * retry launching a fresh `integration-tests` build. These surface "which try
 * are we on" plus the per-iteration build number/result.
 */
export interface JenkinsAttempt {
  /** 1-based attempt index within the pipeline build ("essai N"). */
  attempt: number
  /** `integration-tests` job build number. */
  number: number
  /** "SUCCESS" | "FAILURE" | "ABORTED" | null (still running). */
  result: string | null
  building: boolean
  durationMs: number
  /** Direct link to the `integration-tests` build on Jenkins. */
  url: string
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
  /**
   * Retry attempts of the "Integration tests" stage (the downstream
   * `integration-tests` runs), oldest first. Empty until the build reaches
   * that stage.
   */
  integrationAttempts: JenkinsAttempt[]
  /** Latest "deploy-preview" build for the PR. */
  preview: JenkinsBuild | null
  /** e.g. "https://3959.preview.example.com/admin" */
  previewUrl: string | null
  /** Whether the preview is up to date with the PR head (null until computed). */
  previewFreshness: PreviewFreshness | null
  /** Pending queue item for the PR's pipeline (waiting to start), if any. */
  queue: JenkinsQueueItem | null
  /** "BUILDING" | "QUEUED" | "SUCCESS" | "FAILURE" | "UNKNOWN" */
  overallStatus: string
  /**
   * Where `overallStatus` came from: "jenkins" (a matched build), "github" (the
   * PR head commit status, because Jenkins had already rotated the build out of
   * its short history) or "none". Used to keep tooltips honest.
   */
  verdictSource: string
  /** Epoch seconds when this status was checked. */
  checkedAt: number
}
