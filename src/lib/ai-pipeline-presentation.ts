import type { ValidationExecution, ValidationStep } from '@/types/ai-pipeline'

const stepLabels: Record<ValidationStep, string> = {
  implementation: 'Implémentation',
  review: 'Revue',
  correction: 'Correction',
  git_sync: 'Publication Git',
  create_pr: 'Création de PR',
  ci: 'CI',
  preview: 'Preview',
  acceptance: 'Recette',
  complete: 'Décision',
}

export function validationStepLabel(step: ValidationStep): string {
  return stepLabels[step]
}

/** One current card per worktree; prior executions remain available in history. */
export function selectWorktreeValidation(
  executions: readonly ValidationExecution[],
  worktreeId: string
): ValidationExecution | null {
  const scoped = executions.filter(
    execution => execution.worktree_id === worktreeId
  )
  const current = scoped.filter(execution => !execution.superseded_by)
  if (current.length === 0) {
    return (
      scoped.sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) ||
          b.updated_at.localeCompare(a.updated_at) ||
          b.id.localeCompare(a.id)
      )[0] ?? null
    )
  }

  return (
    current.sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) ||
        b.updated_at.localeCompare(a.updated_at) ||
        b.id.localeCompare(a.id)
    )[0] ?? null
  )
}

/** Explicit persisted provenance only; a manually named chat is never hidden. */
export function validationSessionIds(
  executions: readonly ValidationExecution[],
  worktreeId: string
): Set<string> {
  const ids = new Set<string>()
  for (const execution of executions) {
    if (execution.worktree_id !== worktreeId) continue
    for (const session of execution.agent_sessions ?? [])
      ids.add(session.session_id)
    if (execution.active_session_id) ids.add(execution.active_session_id)
  }
  return ids
}

export function hasCurrentValidationProof(execution: ValidationExecution) {
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

/** Describe the persisted lifecycle, never activity inferred from another chat. */
export function validationNextAction(
  execution: ValidationExecution,
  {
    historical = false,
    ambiguous = false,
  }: { historical?: boolean; ambiguous?: boolean } = {}
): string {
  if (historical || execution.superseded_by)
    return 'Historique consultable : aucune action ne sera relancée.'
  if (ambiguous)
    return 'Les actions sont suspendues : plusieurs cycles se déclarent courants.'
  if (execution.paused)
    return 'Reprends ce cycle pour poursuivre à la même étape.'
  if (execution.status === 'ready')
    return hasCurrentValidationProof(execution)
      ? 'Relis les preuves, puis décide de la suite. Aucun merge automatique.'
      : 'Les preuves actuelles ne suffisent pas à confirmer la recette.'
  if (execution.status === 'failed' || execution.status === 'blocked')
    return 'Ce cycle est arrêté. Consulte le blocage avant de le reprendre.'
  if (execution.status === 'waiting')
    return 'Le cycle attend un résultat externe ; le suivi se met à jour automatiquement.'
  return 'Le cycle poursuit cette étape. Aucune action attendue de ta part.'
}

/** Actual recent route; revisiting review/correction is not linear progress. */
export function validationRecentSteps(
  execution: ValidationExecution
): ValidationStep[] {
  const steps: ValidationStep[] = []
  for (const step of [
    ...execution.transitions.map(t => t.step),
    execution.step,
  ]) {
    if (steps.at(-1) !== step) steps.push(step)
  }
  return steps.slice(-3)
}

export function validationProofSummary(execution: ValidationExecution) {
  const mandatory = execution.requirements.filter(r => r.mandatory)
  const confirmed = mandatory.filter(
    r =>
      r.status === 'passed' &&
      r.evidence_ids.length > 0 &&
      r.evidence_ids.every(id =>
        execution.evidence.some(
          e =>
            e.id === id &&
            !e.stale &&
            !!execution.head_commit &&
            e.commit === execution.head_commit &&
            !!e.value.trim()
        )
      )
  ).length
  return { confirmed, total: mandatory.length }
}
