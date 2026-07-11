import { beforeEach, describe, expect, it } from 'vitest'
import {
  consumeWebReloadState,
  peekWebReloadState,
  saveWebReloadState,
} from './web-reload-state'

describe('web reload state', () => {
  beforeEach(() => sessionStorage.clear())

  it('preserves the open project, modal worktree, and active session', () => {
    saveWebReloadState({
      projectId: 'project-1',
      modalWorktreeId: 'worktree-1',
      modalWorktreePath: '/repo/worktree-1',
      activeSessionId: 'session-1',
    })

    expect(peekWebReloadState()).toEqual({
      projectId: 'project-1',
      modalWorktreeId: 'worktree-1',
      modalWorktreePath: '/repo/worktree-1',
      activeSessionId: 'session-1',
    })
  })

  it('consumes the snapshot only for its project', () => {
    saveWebReloadState({
      projectId: 'project-1',
      modalWorktreeId: 'worktree-1',
      modalWorktreePath: '/repo/worktree-1',
      activeSessionId: 'session-1',
    })

    expect(consumeWebReloadState('project-2')).toBeNull()
    expect(consumeWebReloadState('project-1')?.activeSessionId).toBe(
      'session-1'
    )
    expect(peekWebReloadState()).toBeNull()
  })
})
