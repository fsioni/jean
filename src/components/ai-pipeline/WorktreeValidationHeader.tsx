import { useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { WorktreeValidationStatus } from '@/components/projects/WorktreeValidationStatus'
import { selectWorktreeValidation } from '@/lib/ai-pipeline-presentation'
import type { useAiPipelineValidations } from '@/services/ai-pipeline'
import { ValidationCard } from './AiPipelineValidationPanel'

/** Same backend-owned query and controls as Projects, accessible without leaving chat. */
export function WorktreeValidationHeader({
  worktreeId,
  query,
  onOpenSession,
}: {
  worktreeId: string
  query: ReturnType<typeof useAiPipelineValidations>
  onOpenSession?: (sessionId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const executions = (query.data ?? []).filter(
    e => e.worktree_id === worktreeId
  )
  const current = selectWorktreeValidation(executions, worktreeId)
  const previous = executions.filter(e => e.id !== current?.id)
  if (!current && !query.isError) return null

  const openSession = (sessionId: string) => {
    setOpen(false)
    onOpenSession?.(sessionId)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Suivre la pipeline IA du worktree"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-medium">IA</span>
          {current ? (
            <WorktreeValidationStatus
              executions={executions}
              worktreeId={worktreeId}
              className="pb-0"
            />
          ) : (
            <span>Suivi indisponible</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Suivi de la pipeline IA"
        className="w-[min(30rem,calc(100vw-2rem))] max-h-[min(75dvh,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain"
      >
        <h3 className="mb-3 text-sm font-semibold">Suivi de la pipeline IA</h3>
        {query.isError && (
          <p role="alert" className="mb-3 text-xs text-destructive">
            Suivi indisponible ou périmé.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => query.refetch()}
            >
              Réessayer
            </button>
          </p>
        )}
        {current && (
          <ValidationCard
            execution={current}
            onOpenSession={onOpenSession ? openSession : undefined}
          />
        )}
        {previous.length > 0 && (
          <details className="mt-3 border-t pt-3 text-xs">
            <summary className="cursor-pointer">
              Exécutions précédentes ({previous.length})
            </summary>
            <div className="mt-3 space-y-4">
              {previous.map(execution => (
                <ValidationCard
                  key={execution.id}
                  execution={execution}
                  onOpenSession={onOpenSession ? openSession : undefined}
                />
              ))}
            </div>
          </details>
        )}
      </PopoverContent>
    </Popover>
  )
}
