import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import type { ValidationExecution } from '@/types/ai-pipeline'
import { WorktreeValidationStatus } from './WorktreeValidationStatus'

let executions: ValidationExecution[] = []

function execution(
  overrides: Partial<ValidationExecution> = {}
): ValidationExecution {
  return {
    schema_version: 1,
    id: 'validation',
    project_id: 'project',
    worktree_id: 'worktree',
    repository_path: '/tmp/worktree',
    task_id: 'task',
    pr_number: null,
    revision: 1,
    step: 'implementation',
    status: 'running',
    created_at: '2026-10-07T10:00:00Z',
    updated_at: '2026-10-07T10:00:00Z',
    head_commit: null,
    deployed_commit: null,
    correction_cycles: 0,
    no_progress_cycles: 0,
    requirements: [],
    evidence: [],
    defects: [],
    transitions: [],
    blocker: null,
    paused: false,
    effects: [],
    limitations: [],
    ...overrides,
  }
}

function Subject() {
  return (
    <WorktreeValidationStatus executions={executions} worktreeId="worktree" />
  )
}

describe('WorktreeValidationStatus', () => {
  beforeEach(() => {
    executions = []
  })
  it('leaves existing worktrees without validation unchanged', () => {
    executions = [execution({ worktree_id: 'other' })]
    const { container } = render(<Subject />)
    expect(container).toBeEmptyDOMElement()
  })
  it.each([
    ['running', false, 'En cours'],
    ['waiting', false, 'En attente'],
    ['pending', false, 'En attente'],
    ['blocked', false, 'Bloqué'],
    ['failed', false, 'Échec'],
    ['ready', false, 'Preuves à confirmer'],
    ['running', true, 'En pause'],
  ] as const)(
    'shows step and %s status (paused=%s)',
    (status, paused, label) => {
      executions = [execution({ status, paused, step: 'correction' })]
      render(<Subject />)
      expect(screen.getByRole('status')).toHaveTextContent(
        `Correction · ${label}`
      )
    }
  )
  it.each([false, true])(
    'marks ready green only with current complete proofs (stale=%s)',
    stale => {
      executions = [
        execution({
          status: 'ready',
          step: 'complete',
          head_commit: 'head',
          deployed_commit: 'deployed',
          acceptance_evidence_ids: ['acceptance'],
          requirements: [
            {
              id: 'business',
              label: 'Business',
              mandatory: true,
              status: 'passed',
              evidence_ids: ['acceptance'],
            },
          ],
          evidence: [
            {
              id: 'ci-head',
              kind: 'backend-ci',
              label: 'CI',
              value: 'passed',
              commit: 'head',
              stale: false,
            },
            {
              id: 'preview-version',
              kind: 'git-ancestry',
              label: 'Preview',
              value: 'included',
              commit: 'head',
              stale: false,
            },
            {
              id: 'acceptance',
              kind: 'acceptance',
              label: 'Recette',
              value: 'passed',
              commit: 'head',
              stale,
            },
          ],
        }),
      ]
      render(<Subject />)
      const status = screen.getByRole('status')
      expect(status).toHaveTextContent(stale ? 'Preuves à confirmer' : 'Prêt')
      expect(
        status
          .querySelector('[aria-hidden="true"]')
          ?.classList.contains('bg-success')
      ).toBe(!stale)
    }
  )

  it('updates the current step without navigation', () => {
    executions = [execution()]
    const { rerender } = render(<Subject />)
    expect(screen.getByRole('status')).toHaveTextContent('Implémentation')
    executions = [execution({ step: 'acceptance', status: 'waiting' })]
    rerender(<Subject />)
    expect(screen.getByRole('status')).toHaveTextContent('Recette · En attente')
  })
  it('shows only one execution, preferring active work over an older blocked run', () => {
    executions = [
      execution({ id: 'old', status: 'blocked' }),
      execution({ id: 'new', step: 'ci', updated_at: '2026-10-07T11:00:00Z' }),
    ]
    render(<Subject />)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('CI · En cours')
  })
})
