import { hasCurrentValidationProof } from '@/lib/ai-pipeline-presentation'
import { EvidenceArtifact } from './EvidenceArtifact'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ArrowRight,
  PauseCircle,
} from '@/components/icons/reicon'
import { copyToClipboard } from '@/lib/clipboard'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  useControlAiPipelineValidation,
  useStartAiPipelineValidation,
} from '@/services/ai-pipeline'
import {
  validationStepLabel,
  validationNextAction,
  validationRecentSteps,
  validationProofSummary,
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
  historical = false,
  ambiguous = false,
  unavailable = false,
  compact = false,
}: {
  compact?: boolean
  unavailable?: boolean
  historical?: boolean
  ambiguous?: boolean
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
  const readOnly = historical || !!execution.superseded_by
  const verified =
    !readOnly &&
    !ambiguous &&
    !unavailable &&
    !execution.paused &&
    execution.status === 'ready' &&
    hasCurrentProof(execution)
  const label = readOnly
    ? execution.superseded_by
      ? 'Remplacée · historique'
      : 'Exécution précédente · historique'
    : unavailable
      ? 'Suivi périmé'
      : ambiguous
        ? 'Suivi ambigu'
        : execution.paused
          ? 'En pause'
          : execution.status === 'ready' && !verified
            ? 'Preuves à confirmer'
            : statuses[execution.status]
  const activeBlocker =
    !readOnly &&
    !unavailable &&
    !ambiguous &&
    (execution.paused || ['blocked', 'failed'].includes(execution.status))
  const recentSteps = validationRecentSteps(execution)
  const proof = validationProofSummary(execution)
  const canResume =
    execution.paused || ['blocked', 'failed'].includes(execution.status)
  const nextAction = unavailable
    ? 'Actualise le suivi avant de reprendre une action. Les données affichées sont les dernières connues.'
    : exhaustedCorrectionBudget && !readOnly && !ambiguous
      ? 'Le budget de correction est épuisé. Un nouveau cycle demande une décision explicite.'
      : validationNextAction(execution, { historical: readOnly, ambiguous })
  const controlAction = execution.status !== 'ready' &&
    !readOnly &&
    !ambiguous &&
    !unavailable &&
    !exhaustedCorrectionBudget && (
      <div
        className={
          compact
            ? 'flex flex-wrap items-center gap-2'
            : 'mt-3 flex flex-wrap items-center gap-2'
        }
      >
        <Button
          size="sm"
          variant={canResume ? 'default' : 'outline'}
          disabled={control.isPending}
          aria-busy={control.isPending}
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
                  toast.error(`Impossible de modifier la validation : ${e}`),
              }
            )
          }
        >
          {control.isPending
            ? 'Mise à jour…'
            : canResume
              ? 'Reprendre la validation'
              : 'Mettre en pause'}
        </Button>
        {!compact && !canResume && (
          <span className="basis-full text-xs text-muted-foreground sm:basis-auto sm:flex-1">
            La pause n’arrête ni le chat ni Run.
          </span>
        )}
      </div>
    )
  const restartContent = !readOnly &&
    !ambiguous &&
    !unavailable &&
    ['blocked', 'failed', 'ready'].includes(execution.status) && (
      <div className="space-y-2">
        {confirmRestart ? (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Cela crée une nouvelle validation avec de nouveaux compteurs. Les
              preuves et les limites de cette exécution restent dans
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
                        toast.error(`Nouvelle validation non lancée : ${e}`),
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
    )
  const secondaryContent = (
    <>
      {compact && !activeBlocker && blocker && (
        <div className="text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium">Dernier point signalé</p>
          <p className="whitespace-pre-wrap break-words">{blocker}</p>
        </div>
      )}
      {(!compact || !exhaustedCorrectionBudget) && restartContent}
      <div className="space-y-3 border-t pt-3">
        {execution.transitions.length > 0 && (
          <details className="mb-3 text-xs">
            <summary className="cursor-pointer rounded-sm py-1 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
          <span className="tabular-nums">
            {proof.total
              ? `${proof.confirmed}/${proof.total} exigences avec preuves actuelles`
              : 'Preuves encore à établir'}
          </span>
          <button
            type="button"
            className="rounded-sm py-1 text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={details}
            aria-controls={`proofs-${execution.id}`}
            onClick={() => setDetails(v => !v)}
          >
            {details ? 'Masquer les preuves' : 'Voir les preuves et limites'}
          </button>
        </div>
        {details && (
          <div
            id={`proofs-${execution.id}`}
            className="space-y-3 border-t pt-3 text-xs"
          >
            <p className="break-all text-muted-foreground">
              Exécution {execution.id}
            </p>
            <p className="tabular-nums text-muted-foreground">
              Corrections {execution.correction_cycles}/3 · sans progrès{' '}
              {execution.no_progress_cycles}/2
            </p>
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
              <div
                key={r.id}
                className="flex items-start justify-between gap-2"
              >
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
      </div>
      {onOpenSession &&
        ((execution.agent_sessions?.length ?? 0) > 0 ||
          execution.active_session_id) && (
          <details className="text-xs">
            <summary className="cursor-pointer rounded-sm py-1 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
    </>
  )
  return (
    <article className={compact ? 'min-w-0 space-y-1.5' : 'min-w-0 space-y-4'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          {verified ? (
            <CheckCircle2 className="size-4 text-success" />
          ) : !readOnly &&
            !ambiguous &&
            !unavailable &&
            !execution.paused &&
            execution.status === 'running' ? (
            <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" />
          ) : activeBlocker ? (
            <AlertTriangle
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          ) : execution.paused ? (
            <PauseCircle
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
            />
          ) : (
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
            />
          )}
          {compact ? (
            <span className="text-xs text-muted-foreground">
              Automatisation{' '}
              <span className="ml-2 font-semibold text-foreground">
                {validationStepLabel(execution.step)}
              </span>
            </span>
          ) : (
            <span className="break-words">
              {execution.task_id
                ? `Ticket ${execution.task_id}`
                : 'Worktree courant'}
              {execution.pr_number ? ` · PR #${execution.pr_number}` : ''}
            </span>
          )}
        </div>
        <span
          className={`rounded-md px-2 py-1 text-xs font-medium ${verified ? 'bg-success/10 text-success' : 'bg-muted text-foreground'}`}
          role="status"
        >
          {label}
        </span>
        {compact && <div className="ml-auto">{controlAction}</div>}
      </div>
      <div className="space-y-1">
        {!compact && (
          <p className="text-lg font-semibold leading-tight">
            {validationStepLabel(execution.step)}
          </p>
        )}
        {showLatestActivity && (!compact || !activeBlocker) ? (
          <p
            className={
              compact
                ? 'line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground'
                : 'break-words text-sm leading-relaxed text-muted-foreground'
            }
          >
            {activityMessage(latestActivity)}
          </p>
        ) : !blocker && !compact ? (
          <p
            className={
              compact
                ? 'line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground'
                : 'break-words text-sm leading-relaxed text-muted-foreground'
            }
          >
            Le suivi se met à jour au fil de l’exécution.
          </p>
        ) : null}
      </div>
      {!compact && recentSteps.length > 1 && (
        <ol
          aria-label="Parcours récent, sans estimation de progression"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"
        >
          {recentSteps.map((step, i) => (
            <li key={`${step}-${i}`} className="flex items-center gap-2">
              {i > 0 && <ArrowRight aria-hidden="true" className="size-3" />}
              <span
                aria-current={i === recentSteps.length - 1 ? 'step' : undefined}
                className={
                  i === recentSteps.length - 1
                    ? 'font-medium text-foreground'
                    : undefined
                }
              >
                {validationStepLabel(step)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {ambiguous && !readOnly && (
        <p role="alert" className="text-xs text-destructive">
          Plusieurs validations courantes existent. Les actions sont désactivées
          pour éviter de reprendre la mauvaise exécution.
        </p>
      )}
      {execution.blocker && (!compact || activeBlocker) && (
        <div
          className={
            activeBlocker
              ? 'rounded-md border border-orange-500/20 bg-orange-500/5 p-2 text-xs leading-relaxed'
              : 'space-y-1 text-xs leading-relaxed text-muted-foreground'
          }
          role={activeBlocker ? 'alert' : undefined}
        >
          {!activeBlocker && (
            <p className="font-medium">Dernier point signalé</p>
          )}
          {compact &&
          blocker &&
          (blocker.length > 240 || blocker.includes('\n')) ? (
            <details>
              <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="line-clamp-2 break-words">
                  {blocker.slice(0, 240)}…
                </span>
                <span className="mt-1 block font-medium underline underline-offset-4">
                  Afficher le blocage complet
                </span>
              </summary>
              <p className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap break-words">
                {blocker}
              </p>
            </details>
          ) : (
            <p className="break-words">{blocker}</p>
          )}
        </div>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {nextAction}
      </p>
      {!compact && controlAction}
      {compact && exhaustedCorrectionBudget && restartContent}
      {compact ? (
        <details className="text-xs">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Détails de validation
          </summary>
          <div className="max-h-[50dvh] space-y-3 overflow-y-auto overscroll-contain pt-3">
            {secondaryContent}
          </div>
        </details>
      ) : (
        secondaryContent
      )}
    </article>
  )
}
