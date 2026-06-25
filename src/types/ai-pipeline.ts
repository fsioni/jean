/**
 * AI pipeline PR lifecycle types (mirror of the Rust structs in
 * `src-tauri/src/ai_pipeline/*.rs`, serialized as camelCase).
 */

import type { Worktree } from '@/types/projects'

/** Persisted AI pipeline configuration (sidecar). */
export interface AiPipelineConfig {
  /** Label the pipeline puts on its PRs (defaults to `ai-full-flow`). */
  pipelineLabel?: string
}

/** A pipeline PR surfaced from the dashboard `/prs` endpoint. */
export interface AiPipelinePr {
  number: number
  title: string
  branch: string
  url: string
  /** CI rollup: `SUCCESS` | `FAILURE` | `PENDING` (or absent). */
  ci?: string
  isDraft: boolean
  /** `MERGEABLE` | `CONFLICTING` | `UNKNOWN` (or absent). */
  mergeable?: string
  createdAt: string
  labels: string[]
  /** GitHub `owner/repo` slug this PR belongs to. */
  repoSlug: string
  /** ClickUp task id from the `CU-<id>` branch convention, if any. */
  clickupTaskId?: string
}

/**
 * A ClickUp `TO REVIEW` ticket ready to pick up (unassigned or mine), joined
 * with its PR in the current project's repo. ClickUp is the source of truth for
 * inclusion; the PR carries the resume target + CI state (may be red). Draft PRs
 * are excluded server-side (a draft means the pipeline hasn't finished).
 */
export interface AiPipelineReviewTask {
  taskId: string
  name: string
  status?: string
  /** `true` = already mine, `false` = unassigned (free to grab). */
  assignedToMe: boolean
  url?: string
  pr: AiPipelinePr
}

/** Outcome of one best-effort sub-step. */
export interface StepResult {
  ok: boolean
  message: string
}

/** Result of resuming a pipeline PR. */
export interface ResumeResult {
  worktree: Worktree
  clickupTaskId?: string
  github: StepResult
  clickup: StepResult
}

/** Result of finishing a pipeline PR. */
export interface FinishResult {
  clickup: StepResult
  merge: StepResult
}
