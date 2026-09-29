import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@/types/projects'
import { useRecoverWorktreePrLinks } from './useRecoverWorktreePrLinks'

const invokeMock = vi.fn()
vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  projectsQueryKeys: {
    worktrees: (projectId: string) => ['projects', 'worktrees', projectId],
  },
}))
vi.mock('@/services/jenkins', () => ({
  jenkinsQueryKeys: {
    status: (worktreeId: string) => ['jenkins', 'status', worktreeId],
  },
}))

const worktree = (id: string, branch: string, prNumber?: number): Worktree =>
  ({
    id,
    project_id: 'project-1',
    path: `/tmp/${id}`,
    branch,
    name: id,
    created_at: 0,
    order: 0,
    pr_number: prNumber,
  }) as Worktree

describe('useRecoverWorktreePrLinks', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(null)
  })

  it('recovers PRs added after worktree creation without touching linked or base worktrees', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    invokeMock
      .mockResolvedValueOnce({ pr_number: 4765 })
      .mockResolvedValueOnce({
        worktreeId: 'unlinked',
        overallStatus: 'SUCCESS',
      })
    const worktrees = [
      worktree('unlinked', 'feature'),
      worktree('linked', 'other', 42),
      { ...worktree('base', 'main'), session_type: 'base' as const },
    ]

    renderHook(() => useRecoverWorktreePrLinks('project-1', worktrees), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    expect(invokeMock).toHaveBeenCalledWith('detect_and_link_pr', {
      worktreeId: 'unlinked',
      worktreePath: '/tmp/unlinked',
    })
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['projects', 'worktrees', 'project-1'],
      })
    )
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('get_jenkins_status', {
        projectId: 'project-1',
        worktreeId: 'unlinked',
        prId: '4765',
        branch: 'feature',
      })
    )
    expect(
      client.getQueryData(['jenkins', 'status', 'unlinked'])
    ).toMatchObject({
      overallStatus: 'SUCCESS',
    })
  })

  it('retries missing links when the app regains focus', async () => {
    const client = new QueryClient()
    const worktrees = [worktree('unlinked', 'feature')]
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      renderHook(() => useRecoverWorktreePrLinks('project-1', worktrees), {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      })
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
      act(() => window.dispatchEvent(new Event('focus')))
      expect(invokeMock).toHaveBeenCalledTimes(1)
      now = 61_000
      act(() => window.dispatchEvent(new Event('focus')))
      await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2))
    } finally {
      vi.restoreAllMocks()
    }
  })
})
