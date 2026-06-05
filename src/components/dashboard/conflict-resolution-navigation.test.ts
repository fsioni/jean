import { describe, expect, it, vi } from 'vitest'
import { openCanvasConflictResolution } from './conflict-resolution-navigation'

const worktree = {
  id: 'wt-1',
  path: '/tmp/wt-1',
}

describe('openCanvasConflictResolution', () => {
  it('queues resolve-conflicts before opening the worktree modal', () => {
    const calls: string[] = []
    const actions = {
      setPendingMagicCommand: vi.fn(() => calls.push('queue')),
      openWorktreeModal: vi.fn(() => calls.push('open')),
    }

    openCanvasConflictResolution(worktree, actions)

    expect(actions.setPendingMagicCommand).toHaveBeenCalledWith({
      command: 'resolve-conflicts',
    })
    expect(actions.openWorktreeModal).toHaveBeenCalledWith('wt-1', '/tmp/wt-1')
    expect(calls).toEqual(['queue', 'open'])
  })
})
