import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ValidationExecution } from '@/types/ai-pipeline'
import type { useAiPipelineValidations } from '@/services/ai-pipeline'
import { WorktreeValidationHeader } from './WorktreeValidationHeader'

const control = vi.fn()
vi.mock('@/services/ai-pipeline', () => ({
  useControlAiPipelineValidation: () => ({ mutate: control, isPending: false }),
  useStartAiPipelineValidation: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn() }))
const execution: ValidationExecution = {
  schema_version: 1,
  id: 'v1',
  project_id: 'p1',
  worktree_id: 'w1',
  repository_path: '/tmp/w1',
  task_id: 't1',
  pr_number: 42,
  revision: 1,
  step: 'review',
  status: 'blocked',
  created_at: '',
  updated_at: '',
  head_commit: 'abc',
  deployed_commit: null,
  correction_cycles: 3,
  no_progress_cycles: 0,
  requirements: [],
  evidence: [],
  defects: [],
  transitions: [],
  blocker: 'Étape agent annulée ; réconciliation requise',
  paused: false,
  limitations: [],
  effects: [],
}
const refetch = vi.fn()
function snapshot(data = [execution], isError = false) {
  return { data, isError, isLoading: false, refetch } as unknown as ReturnType<
    typeof useAiPipelineValidations
  >
}

describe('worktree header validation access', () => {
  it('does not add an action for an unrelated worktree', () => {
    const { container } = render(
      <WorktreeValidationHeader worktreeId="other" query={snapshot()} />
    )
    expect(container).toBeEmptyDOMElement()
  })
  it.each([1280, 768, 390])(
    'opens details and resumes the same execution at viewport width %s',
    width => {
      Object.defineProperty(window, 'innerWidth', {
        value: width,
        configurable: true,
      })
      render(<WorktreeValidationHeader worktreeId="w1" query={snapshot()} />)
      fireEvent.click(
        screen.getByRole('button', { name: /Suivre la pipeline IA/ })
      )
      expect(
        screen.getByRole('dialog', { name: 'Suivi de la pipeline IA' })
      ).toBeInTheDocument()
      expect(
        screen.getByText('Étape agent annulée ; réconciliation requise')
      ).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', { name: 'Reprendre la validation' })
      )
      expect(control).toHaveBeenLastCalledWith(
        { executionId: 'v1', action: 'resume' },
        expect.anything()
      )
    }
  )
  it('pauses without stopping chat and scopes controls to the current worktree', () => {
    render(
      <WorktreeValidationHeader
        worktreeId="w1"
        query={snapshot([
          { ...execution, id: 'foreign', worktree_id: 'other' },
          { ...execution, status: 'running', blocker: null },
        ])}
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: /Suivre la pipeline IA/ })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mettre en pause' }))
    expect(control).toHaveBeenLastCalledWith(
      { executionId: 'v1', action: 'pause' },
      expect.anything()
    )
    expect(screen.queryByText(/Exécutions précédentes/)).not.toBeInTheDocument()
  })
  it('shows refreshed status and never claims ready without proofs', () => {
    const view = render(
      <WorktreeValidationHeader worktreeId="w1" query={snapshot()} />
    )
    expect(
      screen.getByRole('button', { name: /Suivre la pipeline IA/ })
    ).toHaveTextContent('Revue · Bloqué')
    view.rerender(
      <WorktreeValidationHeader
        worktreeId="w1"
        query={snapshot([{ ...execution, status: 'ready' }])}
      />
    )
    expect(
      screen.getByRole('button', { name: /Suivre la pipeline IA/ })
    ).toHaveTextContent('Preuves à confirmer')
  })
  it('keeps history separate and opens an existing technical session', () => {
    const onOpenSession = vi.fn()
    render(
      <WorktreeValidationHeader
        worktreeId="w1"
        query={snapshot([
          { ...execution, active_session_id: 'session' },
          { ...execution, id: 'old', superseded_by: 'v1' },
        ])}
        onOpenSession={onOpenSession}
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: /Suivre la pipeline IA/ })
    )
    expect(
      screen.getByText('Exécutions précédentes (1)').closest('details')
    ).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText('Sessions techniques'))
    fireEvent.click(screen.getByRole('button', { name: 'Revue · 1' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onOpenSession).toHaveBeenCalledWith('session')
  })
  it('does not hide a query failure as absence of validation', () => {
    render(
      <WorktreeValidationHeader worktreeId="w1" query={snapshot([], true)} />
    )
    fireEvent.click(
      screen.getByRole('button', { name: /Suivre la pipeline IA/ })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(refetch).toHaveBeenCalled()
  })
})
