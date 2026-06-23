import { cn } from '@/lib/utils'
import { FlaskConical } from 'lucide-react'
import type { JenkinsStage } from '@/types/jenkins'

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

function StageRow({ stage }: { stage: JenkinsStage }) {
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
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatDuration(stage.durationMs)}
      </span>
    </div>
  )
}

/**
 * Per-stage breakdown of a Jenkins `build-and-test` run, shared by the worktree
 * popover (`JenkinsStatusBadge`) and the inline Mission Control row. "Integration
 * tests" is highlighted as the important flaky step.
 */
export function JenkinsStageList({ stages }: { stages: JenkinsStage[] }) {
  if (stages.length === 0) return null
  return (
    <div className="space-y-0.5">
      {stages.map(stage => (
        <StageRow key={stage.name} stage={stage} />
      ))}
    </div>
  )
}
