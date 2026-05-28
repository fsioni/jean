import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAutoArchiveOnMerge } from './useAutoArchiveOnMerge'
import { projectsQueryKeys } from '@/services/projects'
import type { PrStatusEvent } from '@/types/pr-status'
import type { Project, Worktree } from '@/types/projects'

const { mockInvoke, mockUsePrStatusEvents, mockToastSuccess } = vi.hoisted(
  () => ({
    mockInvoke: vi.fn().mockResolvedValue(undefined),
    mockUsePrStatusEvents: vi.fn(),
    mockToastSuccess: vi.fn(),
  })
)

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      auto_archive_on_pr_merged: true,
      removal_behavior: 'archive',
    },
  }),
}))

vi.mock('@/services/pr-status', () => ({
  usePrStatusEvents: mockUsePrStatusEvents,
}))

vi.mock('@/services/projects', async () => {
  const actual = await vi.importActual('@/services/projects')
  return {
    ...actual,
    isTauri: () => true,
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
  },
}))

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'jean',
    path: '/repo/jean',
    default_branch: 'main',
    added_at: 1,
    order: 0,
    ...overrides,
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    project_id: 'project-1',
    name: 'feature-session',
    path: '/repo/jean-worktree',
    branch: 'feature-session',
    created_at: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    order: 0,
    ...overrides,
  }
}

function makeMergedPrStatus(worktreeId: string): PrStatusEvent {
  return {
    worktree_id: worktreeId,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    state: 'merged',
    is_draft: false,
    review_decision: null,
    check_status: 'success',
    display_status: 'merged',
    mergeable: null,
    checked_at: 1,
  }
}

function setup(worktree: Worktree, project = makeProject()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(projectsQueryKeys.list(), [project])
  queryClient.setQueryData(projectsQueryKeys.worktrees(project.id), [worktree])

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  renderHook(() => useAutoArchiveOnMerge(), { wrapper })
  const handler = mockUsePrStatusEvents.mock.calls.at(-1)?.[0] as (
    status: PrStatusEvent
  ) => Promise<void>

  return { handler, queryClient, project }
}

describe('useAutoArchiveOnMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('archives regular worktrees when their linked PR is merged', async () => {
    const { handler } = setup(makeWorktree())

    await act(async () => {
      await handler(makeMergedPrStatus('worktree-1'))
    })

    expect(mockInvoke).toHaveBeenCalledWith('archive_worktree', {
      worktreeId: 'worktree-1',
    })
    expect(mockInvoke).not.toHaveBeenCalledWith('clear_worktree_pr', {
      worktreeId: 'worktree-1',
    })
  })

  it('clears merged PR metadata for base sessions without archiving or deleting them', async () => {
    const { handler, queryClient, project } = setup(
      makeWorktree({
        id: 'base-1',
        name: 'main',
        path: '/repo/jean',
        branch: 'main',
        session_type: 'base',
      })
    )

    await act(async () => {
      await handler(makeMergedPrStatus('base-1'))
    })

    expect(mockInvoke).toHaveBeenCalledWith('clear_worktree_pr', {
      worktreeId: 'base-1',
    })
    expect(mockInvoke).not.toHaveBeenCalledWith('archive_worktree', {
      worktreeId: 'base-1',
    })
    expect(mockInvoke).not.toHaveBeenCalledWith('delete_worktree', {
      worktreeId: 'base-1',
    })

    await waitFor(() => {
      expect(
        queryClient.getQueryCache().find({
          queryKey: projectsQueryKeys.worktrees(project.id),
        })?.state.isInvalidated
      ).toBe(true)
    })
  })
})
