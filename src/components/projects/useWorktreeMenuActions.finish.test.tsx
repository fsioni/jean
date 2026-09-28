import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeMenuActions } from './useWorktreeMenuActions'
import type { Worktree } from '@/types/projects'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  linkedTaskId: '123' as string | null,
  hasAccess: true,
}))

vi.mock('@/services/projects', () => ({
  useArchiveWorktree: () => ({ mutate: vi.fn() }),
  useCloseBaseSession: () => ({ mutate: vi.fn() }),
  useDeleteWorktree: () => ({ mutate: vi.fn() }),
  useOpenWorktreeInFinder: () => ({ mutate: vi.fn() }),
  useOpenWorktreeInTerminal: () => ({ mutate: vi.fn() }),
  useOpenWorktreeInEditor: () => ({ mutate: vi.fn() }),
  useRunScripts: () => ({ data: [] }),
  useUpdateWorktreeStandby: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))
vi.mock('@/services/chat', () => ({
  useSessions: () => ({ data: { sessions: [] } }),
}))
vi.mock('@/services/clickup', () => ({
  useHasClickUpAccess: () => mocks.hasAccess,
  useResolvedClickUpTaskId: () => ({ data: mocks.linkedTaskId }),
}))
vi.mock('@/services/ai-pipeline', () => ({
  useFinishAiPipelinePr: () => ({ mutate: mocks.mutate, isPending: false }),
}))
vi.mock('sonner', () => ({ toast: { loading: vi.fn(() => 'toast-1') } }))

const worktree: Worktree = {
  id: 'wt-42',
  project_id: 'project-1',
  name: 'feature',
  path: '/tmp/project/feature',
  branch: 'CU-123-feature',
  pr_number: 42,
  created_at: 0,
  order: 0,
}

beforeEach(() => {
  mocks.mutate.mockClear()
  mocks.linkedTaskId = '123'
  mocks.hasAccess = true
})

describe('useWorktreeMenuActions finish PR', () => {
  it('finishes the right-clicked worktree and its linked ticket', () => {
    const { result } = renderHook(() =>
      useWorktreeMenuActions({ worktree, projectId: 'project-1' })
    )
    act(() => result.current.handleFinishPr())

    expect(mocks.mutate).toHaveBeenCalledWith(
      { worktreePath: '/tmp/project/feature', taskId: '123' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    )
  })

  it('never merges if the worktree has no linked ticket', () => {
    mocks.linkedTaskId = null
    const { result } = renderHook(() =>
      useWorktreeMenuActions({ worktree, projectId: 'project-1' })
    )
    act(() => result.current.handleFinishPr())
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
})
