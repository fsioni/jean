import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { GitHubIssue } from '@/types/github'
import { useNewWorktreeHandlers } from './useNewWorktreeHandlers'

vi.mock('@/lib/transport', () => ({ invoke: vi.fn() }))

describe('useNewWorktreeHandlers current-worktree issue investigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({ activeWorktreeId: null, worktreePaths: {} })
    useProjectsStore.setState({ selectedWorktreeId: 'worktree-1' })
    useUIStore.setState({ autoInvestigateOverrides: {} })
  })

  it('sends the selected issue context to the new session workflow', async () => {
    vi.mocked(invoke).mockResolvedValue({
      number: 42,
      title: 'Fix login',
      body: 'The login fails',
      comments: [
        {
          body: 'Please fix this',
          author: { login: 'reporter' },
          created_at: '2026-01-01',
        },
      ],
    } as never)

    const data = {
      selectedProjectId: 'project-1',
      selectedProject: { path: '/repo' },
      worktrees: [
        { id: 'worktree-1', project_id: 'project-1', path: '/repo/worktree' },
      ],
      baseSession: null,
    } as unknown as Parameters<typeof useNewWorktreeHandlers>[0]
    const setters = {
      setActiveTab: vi.fn(),
      setSearchQuery: vi.fn(),
      setSelectedItemIndex: vi.fn(),
      setIncludeClosed: vi.fn(),
    }
    const { result } = renderHook(() => useNewWorktreeHandlers(data, setters))

    await act(async () => {
      await result.current.handleInvestigateIssueInNewSession({
        number: 42,
      } as GitHubIssue)
    })

    expect(
      useUIStore.getState().autoInvestigateOverrides['worktree-1']
    ).toEqual(
      expect.objectContaining({
        forceNewSession: true,
        issueContext: {
          number: 42,
          title: 'Fix login',
          body: 'The login fails',
          comments: [
            {
              body: 'Please fix this',
              author: { login: 'reporter' },
              createdAt: '2026-01-01',
            },
          ],
        },
      })
    )
  })
})
