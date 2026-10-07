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
import type { ValidationExecution, ValidationStep } from '@/types/ai-pipeline'

const stages: [ValidationStep, string][] = [
  ['review', 'Review'],
  ['correction', 'Corrections'],
  ['git_sync', 'Git'],
  ['ci', 'CI'],
  ['preview', 'Version'],
  ['acceptance', 'Recette'],
  ['complete', 'Décision'],
]
const statuses = {
  pending: 'À démarrer',
  running: 'En cours',
  waiting: 'En attente',
  blocked: 'Bloqué',
  failed: 'Échec technique',
  ready: 'Prêt pour ta décision',
}

/** Never turn a backend label into a green result without current mandatory proof. */
export function hasCurrentProof(execution: ValidationExecution) {
  const mandatory = execution.requirements.filter(r => r.mandatory)
  const currentEvidence = (ids: string[]) =>
    ids.length > 0 &&
    ids.every(id =>
      execution.evidence.some(
        e => e.id === id && !e.stale && e.commit === execution.head_commit
      )
    )
  const systemProof = (id: string, kind: string) =>
    execution.evidence.some(
      e =>
        e.id === id &&
        e.kind === kind &&
        !e.stale &&
        e.commit === execution.head_commit &&
        !!e.value.trim()
    )
  return (
    systemProof('ci-head', 'backend-ci') &&
    systemProof('preview-version', 'git-ancestry') &&
    mandatory.some(
      r =>
        r.status === 'passed' &&
        r.evidence_ids.some(id =>
          execution.acceptance_evidence_ids?.includes(id)
        )
    ) &&
    !!execution.head_commit &&
    !!execution.deployed_commit &&
    execution.effects.every(effect => effect.confirmed) &&
    mandatory.length > 0 &&
    mandatory.every(
      r =>
        (r.status === 'not_applicable' && !!r.justification?.trim()) ||
        (r.status === 'passed' &&
          currentEvidence(r.evidence_ids) &&
          (r.id === 'ci-head' ||
            r.evidence_ids.some(id =>
              execution.acceptance_evidence_ids?.includes(id)
            )))
    ) &&
    execution.defects
      .filter(d => d.mandatory)
      .every(d => d.resolved && currentEvidence(d.evidence_ids))
  )
}

export function ValidationCard({
  execution,
}: {
  execution: ValidationExecution
}) {
  const [details, setDetails] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const start = useStartAiPipelineValidation(execution.project_id)
  const control = useControlAiPipelineValidation()
  const verified = execution.status === 'ready' && hasCurrentProof(execution)
  const label = execution.superseded_by
    ? 'Remplacée · historique'
    : execution.paused
      ? 'En pause'
      : execution.status === 'ready' && !verified
        ? 'Preuves à confirmer'
        : statuses[execution.status]
  const index = stages.findIndex(([step]) => step === execution.step)
  return (
    <article className="rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {verified ? (
            <CheckCircle2 className="size-4 text-green-600" />
          ) : execution.status === 'running' ? (
            <Loader2 className="size-4 animate-spin text-primary" />
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
      <ol
        className="my-3 grid grid-cols-4 gap-1 sm:grid-cols-7"
        aria-label="Étapes de validation"
      >
        {stages.map(([step, title], i) => (
          <li
            key={step}
            aria-current={step === execution.step ? 'step' : undefined}
            className={`border-t-2 pt-1 text-xs ${i === index ? 'border-primary font-semibold text-foreground' : 'border-border text-muted-foreground'}`}
          >
            <span className="sm:hidden">{i + 1}. </span>
            {title}
          </li>
        ))}
      </ol>
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
          {execution.blocker}
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
      {execution.status !== 'ready' && !execution.superseded_by && (
        <div className="mt-3 flex items-center gap-2">
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
                    toast.error(`Impossible de modifier la validation : ${e}`),
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
          <span className="text-xs text-muted-foreground">
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
}: {
  projectId: string | null
  enabled: boolean
  worktreeId?: string | null
  taskId?: string | null
}) {
  const query = useAiPipelineValidations(projectId, enabled)
  const start = useStartAiPipelineValidation(projectId)
  const active = query.data?.some(
    e =>
      e.worktree_id === worktreeId &&
      !e.superseded_by &&
      e.status !== 'ready' &&
      e.status !== 'failed'
  )
  return (
    <section
      className="max-h-[36vh] shrink-0 space-y-2 overflow-y-auto rounded-lg border border-border bg-muted/20 p-3"
      aria-label="Validations privées"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Validation privée</h3>
          <p className="text-xs text-muted-foreground">
            Des preuves pour décider, pas un merge automatique.
          </p>
        </div>
        {worktreeId && (
          <Button
            size="sm"
            variant="outline"
            disabled={
              start.isPending || query.isLoading || query.isError || active
            }
            onClick={() =>
              start.mutate(
                { worktreeId, taskId: taskId ?? undefined },
                { onError: e => toast.error(`Validation non lancée : ${e}`) }
              )
            }
          >
            {start.isPending
              ? 'Démarrage…'
              : active
                ? 'Validation existante'
                : 'Lancer la validation'}
          </Button>
        )}
      </div>
      {query.isLoading && (
        <p className="text-xs text-muted-foreground">Chargement du suivi…</p>
      )}
      {query.isError && (
        <div role="alert" className="text-xs text-destructive">
          Suivi indisponible.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => query.refetch()}
          >
            Réessayer
          </button>
        </div>
      )}
      {!query.isLoading && !query.isError && query.data?.length === 0 && (
        <p className="py-2 text-xs text-muted-foreground">
          Aucune validation. Récupère un ticket et lance sa validation quand tu
          le souhaites.
        </p>
      )}
      {query.data?.map(execution => (
        <ValidationCard key={execution.id} execution={execution} />
      ))}
    </section>
  )
}
