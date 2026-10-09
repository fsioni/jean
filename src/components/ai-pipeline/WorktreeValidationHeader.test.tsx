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

describe('permanent inline worktree automation', () => {
  it('does not invent automation on an unrelated worktree', () => {
    const view = render(
      <WorktreeValidationHeader worktreeId="other" query={snapshot()} />
    )
    expect(view.container).toBeEmptyDOMElement()
  })
  it.each([1280, 390, 320])(
    'shows stage, state, blocker and resume without any opening click at %s',
    width => {
      Object.defineProperty(window, 'innerWidth', {
        value: width,
        configurable: true,
      })
      control.mockClear()
      render(<WorktreeValidationHeader worktreeId="w1" query={snapshot()} />)
      expect(
        screen.getByRole('region', { name: 'Automatisation du worktree' })
      ).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('Bloqué')
      expect(screen.getByText('Revue')).toBeInTheDocument()
      expect(
        screen.getByText('Étape agent annulée ; réconciliation requise')
      ).toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /Suivre la pipeline/ })
      ).not.toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', { name: 'Reprendre la validation' })
      )
      expect(control).toHaveBeenLastCalledWith(
        { executionId: 'v1', action: 'resume' },
        expect.anything()
      )
      expect(
        screen.getByText('Détails de validation').closest('details')
      ).not.toHaveAttribute('open')
    }
  )
  it('pauses a running cycle directly and renders persisted status changes inline', () => {
    const view = render(
      <WorktreeValidationHeader
        worktreeId="w1"
        query={snapshot([{ ...execution, status: 'running', blocker: null }])}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mettre en pause' }))
    expect(control).toHaveBeenLastCalledWith(
      { executionId: 'v1', action: 'pause' },
      expect.anything()
    )
    view.rerender(
      <WorktreeValidationHeader
        worktreeId="w1"
        query={snapshot([{ ...execution, status: 'ready' }])}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Preuves à confirmer')
  })
  it('keeps sessions and historical executions secondary without a popup', () => {
    const open = vi.fn()
    render(
      <WorktreeValidationHeader
        worktreeId="w1"
        query={snapshot([
          { ...execution, active_session_id: 'technical' },
          { ...execution, id: 'old', superseded_by: 'v1' },
        ])}
        onOpenSession={open}
      />
    )
    expect(
      screen.getByText('Exécutions précédentes (1)').closest('details')
    ).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText('Détails de validation'))
    const sessions = screen.getAllByText('Sessions techniques')[0]
    if (!sessions) throw new Error('Technical session disclosure missing')
    fireEvent.click(sessions)
    fireEvent.click(screen.getByRole('button', { name: 'Revue · 1' }))
    expect(open).toHaveBeenCalledWith('technical')
    expect(
      screen.getByRole('region', { name: 'Automatisation du worktree' })
    ).toBeInTheDocument()
  })
  it('qualifies stale cached status immediately and leaves refresh available', () => {
    render(
      <WorktreeValidationHeader
        worktreeId="w1"
        query={snapshot([execution], true)}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Suivi périmé')
    expect(
      screen.queryByRole('button', { name: 'Reprendre la validation' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(refetch).toHaveBeenCalled()
  })
})

it('keeps long activity compact and exposes the full genuine blocker explicitly', () => {
  const blocker = `Erreur de compilation : ${'diagnostic très long '.repeat(40)}\nDernière ligne utile`
  render(
    <WorktreeValidationHeader
      worktreeId="w1"
      query={snapshot([{ ...execution, blocker }])}
    />
  )
  expect(
    screen.getByText('Afficher le blocage complet').closest('details')
  ).not.toHaveAttribute('open')
  fireEvent.click(screen.getByText('Afficher le blocage complet'))
  expect(
    screen.getByText('Afficher le blocage complet').closest('details')
  ).toHaveAttribute('open')
  expect(screen.getByRole('alert')).toHaveTextContent('Dernière ligne utile')
})

it('keeps the explicit new-cycle action visible when the correction budget is exhausted', () => {
  render(
    <WorktreeValidationHeader
      worktreeId="w1"
      query={snapshot([
        {
          ...execution,
          step: 'correction',
          blocker: 'Correction limit reached; manual decision required',
        },
      ])}
    />
  )
  expect(
    screen.queryByRole('button', { name: 'Reprendre la validation' })
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Nouvelle validation…' })
  ).toBeInTheDocument()
  expect(
    screen.getByText('Détails de validation').closest('details')
  ).not.toHaveAttribute('open')
  fireEvent.click(screen.getByRole('button', { name: 'Nouvelle validation…' }))
  expect(
    screen.getByRole('button', { name: 'Confirmer la nouvelle validation' })
  ).toBeInTheDocument()
})

it('prioritizes the current blocker over a redundant old activity in the compact strip', () => {
  const message = 'Ancienne activité de correction'
  render(
    <WorktreeValidationHeader
      worktreeId="w1"
      query={snapshot([
        {
          ...execution,
          transitions: [
            {
              revision: 1,
              step: 'review',
              status: 'running',
              message,
              timestamp: '',
            },
          ],
        },
      ])}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Étape agent annulée')
  const activity = screen.getByText(message)
  expect(activity.closest('details')).not.toHaveAttribute('open')
  expect(
    screen.getByRole('button', { name: 'Reprendre la validation' })
  ).toBeInTheDocument()
})
