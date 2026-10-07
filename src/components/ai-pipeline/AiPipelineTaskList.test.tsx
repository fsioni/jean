import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import type { AiPipelinePr, AiPipelineTask } from '@/types/ai-pipeline'

const mockTasks = vi.fn()
const mockResumeMutate = vi.fn()
const mockStart = vi.fn()

vi.mock('@/services/ai-pipeline', () => ({
  useAiPipelineTasks: () => mockTasks(),
  useStartAiPipelineValidation: () => ({ mutate: mockStart }),
  useResumeAiPipelineTask: () => ({ mutate: mockResumeMutate }),
}))
vi.mock('@/lib/platform', () => ({ openExternal: vi.fn() }))
vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

import { AiPipelineTaskList } from './AiPipelineTaskList'

function pr(overrides: Partial<AiPipelinePr> = {}): AiPipelinePr {
  return {
    number: 4140,
    title: 'feat(86cauhzpd): actions en masse',
    branch: 'CU-86cauhzpd-actions-en-masse',
    url: 'https://github.com/Spottt/planexpo/pull/4140',
    ci: 'SUCCESS',
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: '2026-07-20T10:00:00Z',
    labels: ['ai-full-flow'],
    repoSlug: 'Spottt/planexpo',
    clickupTaskId: '86cauhzpd',
    ...overrides,
  }
}

function task(overrides: Partial<AiPipelineTask> = {}): AiPipelineTask {
  return {
    taskId: '86cauhzpd',
    name: 'Expliciter le menu Actions en masse',
    status: 'in review',
    assignedToMe: true,
    tags: [],
    pr: pr(),
    ...overrides,
  }
}

const stuckWithoutPr = task({
  taskId: '86canbg67',
  name: 'Arrondis TTC incorrects sur les factures',
  status: 'stuck',
  assignedToMe: false,
  tags: ['ai-done'],
  updatedAt: '1784600000000',
  pr: undefined,
})

function setTasks(
  review: AiPipelineTask[],
  stuck: AiPipelineTask[],
  extra: Record<string, unknown> = {}
) {
  mockTasks.mockReturnValue({
    data: { review, stuck },
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
    ...extra,
  })
}

beforeEach(() => {
  mockTasks.mockReset()
  mockResumeMutate.mockReset()
  mockStart.mockReset()
})

describe('AiPipelineTaskList', () => {
  it('renders both buckets with their counts', () => {
    setTasks([task()], [stuckWithoutPr])
    const { getByText } = render(<AiPipelineTaskList projectId="p1" />)

    expect(getByText('À reprendre')).toBeInTheDocument()
    expect(getByText('Bloqués')).toBeInTheDocument()
    expect(getByText('Expliciter le menu Actions en masse')).toBeInTheDocument()
    expect(
      getByText('Arrondis TTC incorrects sur les factures')
    ).toBeInTheDocument()
  })

  it('marks a stuck ticket without PR and resumes it without a PR number', () => {
    setTasks([], [stuckWithoutPr])
    const { getAllByText, getByRole } = render(
      <AiPipelineTaskList projectId="p1" />
    )

    // The "no PR" state is spelled out, not just colored.
    expect(getAllByText('sans PR').length).toBeGreaterThan(0)

    fireEvent.click(getByRole('button', { name: 'Récupérer' }))
    expect(mockResumeMutate).toHaveBeenCalledWith(
      { taskId: '86canbg67', prNumber: undefined },
      expect.anything()
    )
  })

  it('passes the PR number when the ticket has one', () => {
    setTasks([task()], [])
    const { getByRole } = render(<AiPipelineTaskList projectId="p1" />)

    fireEvent.click(getByRole('button', { name: 'Récupérer' }))
    expect(mockResumeMutate).toHaveBeenCalledWith(
      { taskId: '86cauhzpd', prNumber: 4140 },
      expect.anything()
    )
  })

  it('keeps the list open after a resume and marks the row as taken', async () => {
    setTasks([task()], [])
    const onResumed = vi.fn()
    mockResumeMutate.mockImplementation((_vars, handlers) => {
      handlers.onSuccess({
        worktree: { id: 'w1', path: '/tmp/w1' },
        github: { ok: true, message: 'PR auto-assignée' },
        clickup: { ok: true, message: 'Tâche auto-assignée → IN REVIEW' },
      })
      handlers.onSettled?.()
    })

    const { getByRole, getByText } = render(
      <AiPipelineTaskList projectId="p1" onResumed={onResumed} />
    )
    fireEvent.click(getByRole('button', { name: 'Récupérer' }))

    await waitFor(() => expect(getByText('Récupéré ✓')).toBeInTheDocument())
    // Still mounted: the next ticket is one click away.
    expect(getByText('Expliciter le menu Actions en masse')).toBeInTheDocument()
    expect(onResumed).toHaveBeenCalledOnce()
  })

  it('filters both buckets from the search field', () => {
    setTasks([task()], [stuckWithoutPr])
    const { getByPlaceholderText, queryByText, getByText } = render(
      <AiPipelineTaskList projectId="p1" />
    )

    fireEvent.change(getByPlaceholderText(/Filtrer/), {
      target: { value: 'arrondis' },
    })

    expect(
      queryByText('Expliciter le menu Actions en masse')
    ).not.toBeInTheDocument()
    expect(
      getByText('Arrondis TTC incorrects sur les factures')
    ).toBeInTheDocument()
  })

  it('shows a per-bucket empty state instead of an empty screen', () => {
    setTasks([], [])
    const { getByText } = render(<AiPipelineTaskList projectId="p1" />)
    expect(getByText(/Aucun ticket en review à reprendre/)).toBeInTheDocument()
    expect(getByText(/Aucun ticket bloqué/)).toBeInTheDocument()
  })
})

describe('private validation launch', () => {
  it('starts only after successful recovery and retains the worktree context', () => {
    setTasks([task()], [])
    mockResumeMutate.mockImplementation((_vars, handlers) => {
      handlers.onSuccess({
        worktree: { id: 'w1' },
        github: { ok: true },
        clickup: { ok: true },
      })
    })
    const view = render(<AiPipelineTaskList projectId="p1" />)
    fireEvent.click(view.getByRole('button', { name: 'Récupérer et valider' }))
    expect(mockStart).toHaveBeenCalledWith(
      { worktreeId: 'w1', taskId: '86cauhzpd', prNumber: 4140 },
      expect.anything()
    )
    expect(view.getByRole('button', { name: 'Récupéré ✓' })).toBeDisabled()
  })
  it('does not start after a partial assignment failure', () => {
    setTasks([task()], [])
    mockResumeMutate.mockImplementation((_vars, handlers) => {
      handlers.onSuccess({
        worktree: { id: 'w1' },
        github: { ok: true },
        clickup: { ok: false },
      })
    })
    const view = render(<AiPipelineTaskList projectId="p1" />)
    fireEvent.click(view.getByRole('button', { name: 'Récupérer et valider' }))
    expect(mockStart).not.toHaveBeenCalled()
  })
  it('does not infer green CI from absent status', () => {
    setTasks([task({ pr: pr({ ci: undefined }) })], [])
    const view = render(<AiPipelineTaskList projectId="p1" />)
    expect(view.getByText('CI inconnue')).toBeInTheDocument()
    expect(view.queryByText('CI OK')).not.toBeInTheDocument()
  })
})
