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
  const priority = (execution: ValidationExecution) => {
    if (!execution.paused && execution.status === 'running') return 3
    if (!execution.paused && ['pending', 'waiting'].includes(execution.status))
      return 2
    if (execution.status === 'blocked' || execution.paused) return 1
    return 0
  }
  return (
    current.sort(
      (a, b) =>
        priority(b) - priority(a) ||
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
