import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { selectWorktreeValidation } from '@/lib/ai-pipeline-presentation'
import {
  useStartAiPipelineValidation,
  type useAiPipelineValidations,
} from '@/services/ai-pipeline'
import { ValidationCard } from './ValidationCard'

/** Permanent worktree strip, shared by canvas and chat. Only supporting details collapse. */
export function WorktreeValidationInline({
  worktreeId,
  query,
  projectId = null,
  taskId,
  allowStart = false,
  onOpenSession,
}: {
  worktreeId: string
  query: ReturnType<typeof useAiPipelineValidations>
  projectId?: string | null
  taskId?: string | null
  allowStart?: boolean
  onOpenSession?: (sessionId: string) => void
}) {
  const start = useStartAiPipelineValidation(projectId)
  const executions = (query.data ?? []).filter(
    e => e.worktree_id === worktreeId
  )
  const current = selectWorktreeValidation(executions, worktreeId)
  const ambiguous = executions.filter(e => !e.superseded_by).length > 1
  const previous = executions.filter(e => e.id !== current?.id)
  if (!current && !allowStart && !query.isError) return null
  return (
    <section
      aria-label="Automatisation du worktree"
      className="min-w-0 border-t border-border/40 px-4 py-2"
    >
      {query.isError && (
        <p role="alert" className="mb-1 text-xs text-destructive">
          Suivi indisponible ou périmé.{' '}
          <button
            type="button"
            className="rounded-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => query.refetch()}
          >
            Réessayer
          </button>
        </p>
      )}
      {current ? (
        <ValidationCard
          key={current.id}
          execution={current}
          compact
          ambiguous={ambiguous}
          unavailable={query.isError}
          onOpenSession={onOpenSession}
        />
      ) : allowStart ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            Automatisation ·{' '}
            {query.isLoading ? 'Chargement du suivi…' : 'Aucun cycle lancé'}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={start.isPending || query.isLoading || query.isError}
            onClick={() =>
              start.mutate(
                { worktreeId, taskId: taskId ?? undefined },
                { onError: e => toast.error(`Validation non lancée : ${e}`) }
              )
            }
          >
            {start.isPending ? 'Démarrage…' : 'Lancer la validation'}
          </Button>
        </div>
      ) : null}
      {previous.length > 0 && (
        <details className="mt-1.5 text-xs">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Exécutions précédentes ({previous.length})
          </summary>
          <div className="max-h-[50dvh] space-y-4 overflow-y-auto overscroll-contain pt-3">
            {previous.map(execution => (
              <ValidationCard
                key={execution.id}
                execution={execution}
                historical
                unavailable={query.isError}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  )
}
