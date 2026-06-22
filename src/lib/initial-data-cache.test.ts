import { describe, expect, it } from 'vitest'
import { collectWorktreePaths } from './initial-data-cache'

describe('initial data cache helpers', () => {
  it('collects worktree paths from reconnect data without requiring sessions payload', () => {
    expect(
      collectWorktreePaths({
        'project-1': [
          { id: 'worktree-1', path: '/repo/wt1' },
          { id: 'worktree-2', path: '/repo/wt2' },
        ],
      })
    ).toEqual({
      'worktree-1': '/repo/wt1',
      'worktree-2': '/repo/wt2',
    })
  })
})
