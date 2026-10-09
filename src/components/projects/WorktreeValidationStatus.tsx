import {
  hasCurrentValidationProof,
  selectWorktreeValidation,
  validationStepLabel,
} from '@/lib/ai-pipeline-presentation'
import type { ValidationExecution, ValidationStatus } from '@/types/ai-pipeline'
import { cn } from '@/lib/utils'

const statusLabels: Record<ValidationStatus, string> = {
  pending: 'En attente',
  running: 'En cours',
  waiting: 'En attente',
  blocked: 'Bloqué',
  failed: 'Échec',
  ready: 'Prêt',
}

/** Shared Projects row: same cached, backend-owned state in native and Web Access. */
export function WorktreeValidationStatus({
  executions,
  worktreeId,
  className,
  stale = false,
}: {
  executions: readonly ValidationExecution[]
  worktreeId: string
  className?: string
  stale?: boolean
}) {
  const execution = selectWorktreeValidation(executions, worktreeId)
  if (!execution) return null

  const ambiguous =
    executions.filter(e => e.worktree_id === worktreeId && !e.superseded_by)
      .length > 1
  const verifiedReady =
    !stale &&
    !ambiguous &&
    !execution.superseded_by &&
    execution.status === 'ready' &&
    hasCurrentValidationProof(execution)
  const statusLabel = stale
    ? 'Suivi périmé'
    : ambiguous
      ? 'Suivi ambigu'
      : execution.superseded_by
        ? 'Historique · remplacée'
        : execution.paused
          ? 'En pause'
          : execution.status === 'ready' && !verifiedReady
            ? 'Preuves à confirmer'
            : statusLabels[execution.status]
  const label = `${validationStepLabel(execution.step)} · ${statusLabel}`
  return (
    <div
      role="status"
      aria-label={`Pipeline IA : ${label}`}
      title={label}
      className={cn(
        'flex min-w-0 items-center gap-1.5 pb-1 text-[11px] text-muted-foreground',
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full bg-muted-foreground/50',
          !stale &&
            !ambiguous &&
            !execution.superseded_by &&
            !execution.paused &&
            execution.status === 'running' &&
            'bg-primary motion-safe:animate-pulse',
          !stale &&
            !ambiguous &&
            !execution.superseded_by &&
            !execution.paused &&
            verifiedReady &&
            'bg-success',
          !stale &&
            !ambiguous &&
            !execution.superseded_by &&
            !execution.paused &&
            (execution.status === 'blocked' || execution.status === 'failed') &&
            'bg-destructive'
        )}
      />
      <span className="truncate">{label}</span>
    </div>
  )
}
