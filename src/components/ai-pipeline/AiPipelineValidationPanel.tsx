import { hasCurrentValidationProof } from '@/lib/ai-pipeline-presentation'
import { EvidenceArtifact } from './EvidenceArtifact'
import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Loader2 } from '@/components/icons/reicon'
import { copyToClipboard } from '@/lib/clipboard'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  useAiPipelineValidations,
  useControlAiPipelineValidation,
  useStartAiPipelineValidation,
} from '@/services/ai-pipeline'
import {
  selectWorktreeValidation,
  validationStepLabel,
} from '@/lib/ai-pipeline-presentation'
import type { ValidationExecution } from '@/types/ai-pipeline'

const statuses = {
  pending: 'À démarrer',
  running: 'En cours',
  waiting: 'En attente',
  blocked: 'Bloqué',
  failed: 'Échec technique',
  ready: 'Prêt pour ta décision',
}

const legacyCorrectionLimit =
  'Correction limit reached; manual decision required'
const correctionLimitExplanation =
  'Limite de corrections atteinte : 3 tentatives maximum ou 2 tentatives sans progrès vérifié. Une décision explicite est nécessaire pour poursuivre.'

function isCorrectionLimit(message: string | null | undefined) {
  return (
    message === legacyCorrectionLimit ||
    !!message?.startsWith('Limite de correction atteinte :')
  )
}

function activityMessage(message: string) {
  return message === legacyCorrectionLimit
    ? correctionLimitExplanation
    : message
}

/** Never turn a backend label into a green result without current mandatory proof. */
export const hasCurrentProof = hasCurrentValidationProof

export function ValidationCard({
  execution,
  onOpenSession,
}: {
  execution: ValidationExecution
  onOpenSession?: (sessionId: string) => void
}) {
  const [details, setDetails] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const start = useStartAiPipelineValidation(execution.project_id)
  const control = useControlAiPipelineValidation()
  const exhaustedCorrectionBudget =
    ['blocked', 'failed'].includes(execution.status) &&
    isCorrectionLimit(execution.blocker)
  const blocker = execution.blocker ? activityMessage(execution.blocker) : null
  const latestActivity = execution.transitions.at(-1)?.message
  const showLatestActivity =
    latestActivity && latestActivity !== execution.blocker
  const verified = execution.status === 'ready' && hasCurrentProof(execution)
  const label = execution.superseded_by
    ? 'Remplacée · historique'
    : execution.paused
      ? 'En pause'
      : execution.status === 'ready' && !verified
        ? 'Preuves à confirmer'
        : statuses[execution.status]
  return (
    <article className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {verified ? (
            <CheckCircle2 className="size-4 text-green-600" />
          ) : execution.status === 'running' ? (
            <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" />
          ) : (
            <AlertTriangle className="size-4 text-muted-foreground" />
          )}
          <span>
            {execution.task_id
              ? `Ticket ${execution.task_id}`
              : 'Worktree courant'}
            {execution.pr_number ? ` · PR #${execution.pr_number}` : ''}
          </span>
        </div>
        <span
          className={`rounded-md px-2 py-1 text-xs font-medium ${verified ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-muted text-foreground'}`}
          role="status"
        >
          {label}
        </span>
      </div>
      <div className="my-3 border-l border-primary pl-3">
        <p className="text-sm font-medium">
          {validationStepLabel(execution.step)}
        </p>
        {showLatestActivity ? (
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {activityMessage(latestActivity)}
          </p>
        ) : !blocker ? (
          <p className="mt-1 break-words text-xs text-muted-foreground">
            Le suivi se met à jour au fil de l’exécution.
          </p>
        ) : null}
      </div>
      {execution.transitions.length > 0 && (
        <details className="mb-3 text-xs">
          <summary className="cursor-pointer py-1 text-muted-foreground">
            Journal d’activité ({execution.transitions.length})
          </summary>
          <ol
            className="mt-2 space-y-3 border-l border-border pl-3"
            aria-label="Journal de validation"
          >
            {execution.transitions.map((event, i) => (
              <li key={`${event.revision}-${i}`}>
                <div className="flex flex-wrap gap-x-2 text-muted-foreground">
                  <span>{validationStepLabel(event.step)}</span>
                  <time dateTime={event.timestamp}>
                    {event.timestamp
                      ? new Date(event.timestamp).toLocaleString('fr-FR')
                      : ''}
                  </time>
                </div>
                <p className="mt-1 break-words">
                  {activityMessage(event.message)}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Corrections {execution.correction_cycles}/3 · sans progrès{' '}
          {execution.no_progress_cycles}/2
        </span>
        <button
          type="button"
          className="text-foreground underline underline-offset-4"
          aria-expanded={details}
          onClick={() => setDetails(v => !v)}
        >
          {details ? 'Masquer les preuves' : 'Voir les preuves et limites'}
        </button>
      </div>
      {execution.blocker && (
        <p
          className="mt-3 rounded-md border border-orange-500/20 bg-orange-500/5 p-2 text-xs leading-relaxed"
          role="alert"
        >
          {blocker}
        </p>
      )}
      {details && (
        <div className="mt-3 space-y-3 border-t pt-3 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Commit testé</dt>
            <dd className="break-all font-mono">
              {execution.head_commit ?? 'Non confirmé'}
            </dd>
            <dt className="text-muted-foreground">Commit déployé</dt>
            <dd className="break-all font-mono">
              {execution.deployed_commit ?? 'Non confirmé'}
            </dd>
          </dl>
          {execution.requirements.length === 0 && (
            <p className="text-muted-foreground">
              Aucune exigence vérifiée pour le moment.
            </p>
          )}
          {execution.requirements.map(r => (
            <div key={r.id} className="flex items-start justify-between gap-2">
              <span>
                {r.label}
                {r.mandatory && ' · obligatoire'}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {
                  {
                    passed: 'Validé',
                    failed: 'Échec',
                    unverified: 'Non vérifié',
                    not_applicable: 'Non applicable',
                  }[r.status]
                }
              </span>
            </div>
          ))}
          {execution.evidence.map(e => (
            <EvidenceArtifact key={e.id} evidence={e} />
          ))}
          {execution.limitations.map((limit, i) => (
            <p key={i} className="text-muted-foreground">
              {limit}
            </p>
          ))}
          <p className="text-muted-foreground">
            Rapport privé. Aucun merge ni retour aux collègues automatique. Le
            confinement technique des outils de l’agent n’est pas garanti.
          </p>
        </div>
      )}
      {execution.status !== 'ready' &&
        !execution.superseded_by &&
        !exhaustedCorrectionBudget && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={control.isPending}
              onClick={() =>
                control.mutate(
                  {
                    executionId: execution.id,
                    action:
                      execution.paused ||
                      execution.status === 'blocked' ||
                      execution.status === 'failed'
                        ? 'resume'
                        : 'pause',
                  },
                  {
                    onError: e =>
                      toast.error(
                        `Impossible de modifier la validation : ${e}`
                      ),
                  }
                )
              }
            >
              {execution.paused ||
              execution.status === 'blocked' ||
              execution.status === 'failed'
                ? 'Reprendre la validation'
                : 'Mettre en pause'}
            </Button>
            <span className="basis-full text-xs text-muted-foreground sm:basis-auto sm:flex-1">
              La pause n’arrête ni le chat ni Run.
            </span>
          </div>
        )}
      {!execution.superseded_by &&
        ['blocked', 'failed', 'ready'].includes(execution.status) && (
          <div className="mt-3 space-y-2 border-t pt-3">
            {confirmRestart ? (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Cela crée une nouvelle validation avec de nouveaux compteurs.
                  Les preuves et les limites de cette exécution restent dans
                  l’historique. Un run encore actif doit d’abord se terminer.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={start.isPending}
                    onClick={() =>
                      start.mutate(
                        {
                          worktreeId: execution.worktree_id,
                          taskId: execution.task_id,
                          prNumber: execution.pr_number ?? undefined,
                          newExecution: true,
                        },
                        {
                          onSuccess: () => {
                            setConfirmRestart(false)
                            toast.success('Nouvelle validation créée.')
                          },
                          onError: e =>
                            toast.error(
                              `Nouvelle validation non lancée : ${e}`
                            ),
                        }
                      )
                    }
                  >
                    {start.isPending
                      ? 'Démarrage…'
                      : 'Confirmer la nouvelle validation'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmRestart(false)}
                  >
                    Annuler
                  </Button>
                </div>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRestart(true)}
              >
                Nouvelle validation…
              </Button>
            )}
          </div>
        )}
      {onOpenSession &&
        ((execution.agent_sessions?.length ?? 0) > 0 ||
          execution.active_session_id) && (
          <details className="text-xs">
            <summary className="cursor-pointer py-1 font-medium">
              Sessions techniques
            </summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {(execution.agent_sessions?.length
                ? execution.agent_sessions
                : [
                    {
                      session_id: execution.active_session_id ?? '',
                      step: execution.step,
                      attempt_id: 'active',
                    },
                  ]
              ).map((session, i) => (
                <Button
                  key={session.session_id}
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenSession(session.session_id)}
                >
                  {validationStepLabel(session.step)} · {i + 1}
                </Button>
              ))}
            </div>
          </details>
        )}

      <div className="mt-3 border-t pt-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const validated = execution.requirements.filter(
              r =>
                r.status === 'passed' &&
                r.evidence_ids.length > 0 &&
                r.evidence_ids.every(id =>
                  execution.evidence.some(
                    e =>
                      e.id === id &&
                      !e.stale &&
                      e.commit === execution.head_commit
                  )
                )
            )
            const validatedIds = new Set(validated.map(r => r.id))
            const remaining = execution.requirements.filter(
              r =>
                r.mandatory &&
                !validatedIds.has(r.id) &&
                !(r.status === 'not_applicable' && r.justification?.trim())
            )
            setDraft(
              [
                validated.length
                  ? `J’ai vérifié : ${validated.map(r => r.label).join(' ; ')}.`
                  : 'La vérification est encore en cours.',
                remaining.length
                  ? `Il reste à vérifier : ${remaining.map(r => r.label).join(' ; ')}.`
                  : '',
              ]
                .filter(Boolean)
                .join('\n\n')
            )
          }}
        >
          Préparer mon retour
        </Button>
        {draft !== null && (
          <div className="mt-2 space-y-2">
            <label
              className="block text-xs font-medium"
              htmlFor={`draft-${execution.id}`}
            >
              Brouillon privé · à relire et publier toi-même
            </label>
            <Textarea
              id={`draft-${execution.id}`}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="min-h-28 text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                copyToClipboard(draft)
                  .then(() =>
                    toast.success('Brouillon copié, rien n’a été publié.')
                  )
                  .catch(e => toast.error(`Copie impossible : ${e}`))
              }}
            >
              Copier mon retour
            </Button>
          </div>
        )}
      </div>
    </article>
  )
}

export function AiPipelineValidationPanel({
  projectId,
  enabled,
  worktreeId,
  taskId,
  onOpenSession,
  querySnapshot,
  allowStart = false,
}: {
  projectId: string | null
  enabled: boolean
  worktreeId?: string | null
  taskId?: string | null
  allowStart?: boolean
  onOpenSession?: (sessionId: string) => void
  querySnapshot?: ReturnType<typeof useAiPipelineValidations>
}) {
  const ownQuery = useAiPipelineValidations(
    projectId,
    enabled && !querySnapshot
  )
  const query = querySnapshot ?? ownQuery
  const start = useStartAiPipelineValidation(projectId)
  const [expanded, setExpanded] = useState(false)
  const executions = (query.data ?? []).filter(
    e => e.worktree_id === worktreeId
  )
  const current = worktreeId
    ? selectWorktreeValidation(executions, worktreeId)
    : undefined
  const previous = executions.filter(e => e.id !== current?.id)
  if (!worktreeId || (!current && !allowStart && !taskId)) return null
  const currentLabel =
    current?.status === 'ready' && !hasCurrentProof(current)
      ? 'Preuves à confirmer'
      : current
        ? statuses[current.status]
        : 'À démarrer'
  return (
    <section
      className="mx-3 mb-2 min-w-0 rounded-md border border-border bg-muted/20"
      aria-label="Activité IA du worktree"
    >
      <div className="flex flex-wrap items-start gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-left text-xs hover:text-primary"
          aria-label="Suivre la validation"
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
        >
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap font-medium">
            {current?.status === 'running' && !current.paused && (
              <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
            )}
            Activité IA
          </span>
          <span className="basis-full text-muted-foreground sm:basis-auto">
            {current
              ? `${validationStepLabel(current.step)} · ${current.paused ? 'En pause' : currentLabel}`
              : query.isLoading
                ? 'Chargement du suivi…'
                : 'À démarrer'}
          </span>
        </button>
        {current && current.correction_cycles > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">
            Corrections {current.correction_cycles}/3
          </span>
        )}
      </div>
      {query.isError && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          Suivi indisponible.{' '}
          <button className="underline" onClick={() => query.refetch()}>
            Réessayer
          </button>
        </p>
      )}
      {expanded && (
        <div className="space-y-3 border-t p-3">
          {!current && (
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
          )}
          {current && (
            <ValidationCard
              key={current.id}
              execution={current}
              onOpenSession={onOpenSession}
            />
          )}
          {previous.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer py-1 text-muted-foreground">
                Exécutions précédentes ({previous.length})
              </summary>
              <div className="mt-2 space-y-2">
                {previous.map(execution => (
                  <ValidationCard
                    key={execution.id}
                    execution={execution}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  )
}
