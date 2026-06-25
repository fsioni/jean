import { useCallback } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { cn } from '@/lib/utils'
import { ExternalLink, FlaskConical } from 'lucide-react'
import type { JenkinsAttempt, JenkinsStage } from '@/types/jenkins'

/** The flaky stage we highlight everywhere it's listed. */
export const INTEGRATION_TESTS_STAGE = 'Integration tests'

/** Format a duration in ms as mm:ss. */
export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/** Color for a per-stage status dot. */
export function stageDotClass(status: string): string {
  switch (status) {
    case 'SUCCESS':
      return 'bg-green-500'
    case 'FAILED':
      return 'bg-red-500'
    case 'IN_PROGRESS':
      return 'bg-blue-500 animate-pulse'
    case 'ABORTED':
      return 'bg-amber-500'
    default:
      // NOT_EXECUTED and anything unknown
      return 'bg-muted-foreground/40'
  }
}

/** Short, colorblind-safe label for a stage status (shape/dot carries color). */
function stageStatusLabel(status: string): string {
  switch (status) {
    case 'SUCCESS':
      return 'réussi'
    case 'FAILED':
      return 'échec'
    case 'IN_PROGRESS':
      return 'en cours'
    case 'ABORTED':
      return 'interrompu'
    case 'NOT_EXECUTED':
      return 'en attente'
    default:
      return status.toLowerCase()
  }
}

function StageRow({
  stage,
  attemptCount = 0,
}: {
  stage: JenkinsStage
  /** Number of `integration-tests` retry attempts (only on the flaky stage). */
  attemptCount?: number
}) {
  const isIntegration = stage.name === INTEGRATION_TESTS_STAGE
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded px-1.5 py-1 text-xs',
        isIntegration && 'bg-muted/60 font-medium'
      )}
      // Spells out the status in text so it isn't conveyed by the dot color alone.
      title={`${stage.name} : ${stageStatusLabel(stage.status)}`}
    >
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          stageDotClass(stage.status)
        )}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {stage.name}
        {isIntegration && (
          <FlaskConical className="ml-1 inline-block h-3 w-3 text-muted-foreground" />
        )}
        {attemptCount > 0 && (
          <span
            className="ml-1.5 rounded bg-muted px-1 text-[10px] font-normal tabular-nums text-muted-foreground"
            title={`Integration tests lancé ${attemptCount} fois (essais ci-dessous)`}
          >
            {attemptCount} essai{attemptCount > 1 ? 's' : ''}
          </span>
        )}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatDuration(stage.durationMs)}
      </span>
    </div>
  )
}

/** Color for a per-attempt status dot. */
function attemptDotClass(attempt: JenkinsAttempt): string {
  if (attempt.building) return 'bg-blue-500 animate-pulse'
  switch (attempt.result) {
    case 'SUCCESS':
      return 'bg-green-500'
    case 'FAILURE':
      return 'bg-red-500'
    case 'ABORTED':
      return 'bg-amber-500'
    default:
      return 'bg-muted-foreground/40'
  }
}

/** Short, colorblind-safe label for an attempt status (dot carries color too). */
function attemptStatusLabel(attempt: JenkinsAttempt): string {
  if (attempt.building) return 'en cours'
  switch (attempt.result) {
    case 'SUCCESS':
      return 'réussi'
    case 'FAILURE':
      return 'échec'
    case 'ABORTED':
      return 'interrompu'
    default:
      return 'en attente'
  }
}

/** One retry attempt of the Integration tests stage (a downstream run). */
function AttemptRow({ attempt }: { attempt: JenkinsAttempt }) {
  const handleOpen = useCallback(() => {
    if (attempt.url) openUrl(attempt.url)
  }, [attempt.url])
  return (
    <div
      className="flex items-center gap-2 rounded px-1.5 py-0.5 text-[11px]"
      // Status spelled out in text — not conveyed by the dot color alone.
      title={`Essai ${attempt.attempt} (#${attempt.number}) : ${attemptStatusLabel(attempt)}`}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          attemptDotClass(attempt)
        )}
      />
      <span className="shrink-0 text-muted-foreground">
        essai {attempt.attempt}
      </span>
      <button
        type="button"
        onClick={handleOpen}
        className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground transition-colors hover:text-foreground"
        title="Ouvrir le build integration-tests sur Jenkins"
      >
        #{attempt.number}
        <ExternalLink className="h-2.5 w-2.5" />
      </button>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {attemptStatusLabel(attempt)}
      </span>
      {attempt.durationMs > 0 && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatDuration(attempt.durationMs)}
        </span>
      )}
    </div>
  )
}

/** The retry attempts of the Integration tests stage, indented beneath it. */
function IntegrationAttemptList({ attempts }: { attempts: JenkinsAttempt[] }) {
  return (
    <div className="ml-3 mt-0.5 space-y-0.5 border-l border-border/60 pl-2">
      {attempts.map(attempt => (
        <AttemptRow key={attempt.number} attempt={attempt} />
      ))}
    </div>
  )
}

/**
 * Per-stage breakdown of a Jenkins `build-and-test` run, shared by the worktree
 * popover (`JenkinsStatusBadge`) and the inline Mission Control row. "Integration
 * tests" is highlighted as the important flaky step.
 *
 * When `attempts` are supplied, the flaky stage also shows its retry counter
 * ("N essais") and, indented beneath it, each `integration-tests` run (build
 * number + per-iteration result) so "which try are we on" is visible inline.
 */
export function JenkinsStageList({
  stages,
  attempts = [],
}: {
  stages: JenkinsStage[]
  attempts?: JenkinsAttempt[]
}) {
  if (stages.length === 0) return null
  return (
    <div className="space-y-0.5">
      {stages.map(stage => {
        const showAttempts =
          stage.name === INTEGRATION_TESTS_STAGE && attempts.length > 0
        return (
          <div key={stage.name}>
            <StageRow
              stage={stage}
              attemptCount={showAttempts ? attempts.length : 0}
            />
            {showAttempts && <IntegrationAttemptList attempts={attempts} />}
          </div>
        )
      })}
    </div>
  )
}
