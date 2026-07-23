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
  /** e.g. "Cypress Unified", "Rust unit tests" */
  name: string
  /** "SUCCESS" | "FAILED" | "IN_PROGRESS" | "NOT_EXECUTED" | "ABORTED" */
  status: string
  durationMs: number
}

/**
 * One attempt of the flaky end-to-end stage within a pipeline build.
 *
 * The stage retries in place on failure — each try is another step inside the
 * same stage — so these surface "which try are we on" plus each try's own
 * result, duration and log link.
 */
export interface JenkinsAttempt {
  /** 1-based attempt index within the stage ("essai N"). */
  attempt: number
  /** "SUCCESS" | "FAILURE" | "ABORTED" | null (still running). */
  result: string | null
  building: boolean
  durationMs: number
  /** Direct link to this attempt's console log on Jenkins. */
  url: string
}

/** One failing test case from a build's JUnit report. */
export interface JenkinsFailedTest {
  className: string
  name: string
  /** Assertion message, or the head of the stack trace when the runner (jest)
   * leaves `errorDetails` empty. */
  message: string | null
}

/**
 * Why a pipeline build failed — the diagnostic that replaces opening Jenkins.
 *
 * Resolved on demand (`get_jenkins_failure_report`), not by the poller: it costs
 * several Jenkins round-trips, so it is only fetched when the user asks.
 */
export interface JenkinsFailureReport {
  /** Pipeline build the report was computed from. */
  pipelineNumber: number
  /** First failed stage, e.g. "Cypress Unified" (null when nothing looks failed). */
  stage: string | null
  /** Downstream job the stage delegated to, e.g. "unified-deploy-preview". */
  downstreamJob: string | null
  downstreamNumber: number | null
  /** Best link to the actually-failing console on Jenkins. */
  consoleUrl: string | null
  /** Failing test cases (capped — compare with `failedTestCount`). */
  failedTests: JenkinsFailedTest[]
  /** Total failing tests reported by Jenkins. */
  failedTestCount: number
  /** Cleaned tail of the failing log (pipeline noise stripped). */
  logExcerpt: string
}

/** A pending item in the Jenkins build queue (not yet a build). */
export interface JenkinsQueueItem {
  /** Why it's waiting, e.g. "Build #4,798 is already in progress". */
  why: string | null
  /** Epoch milliseconds when it entered the queue. */
  sinceMs: number
  /** Blocked (serialized behind a running build / waiting on a lock). */
  blocked: boolean
  /** 1-based rank among the pipeline items waiting (oldest first). */
  position: number
  /** How many pipeline items are waiting in total. */
  total: number
}

/** Aggregated Jenkins status for a single worktree / PR. */
export interface JenkinsWorktreeStatus {
  worktreeId: string
  prId: string | null
  /** Latest unified pipeline build for the PR. */
  pipeline: JenkinsBuild | null
  /** Per-stage breakdown of the pipeline. */
  stages: JenkinsStage[]
  /**
   * Attempts of the flaky end-to-end stage, oldest first. Empty until the
   * build reaches that stage.
   */
  integrationAttempts: JenkinsAttempt[]
  /** Latest preview-deploy build for the PR. */
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
