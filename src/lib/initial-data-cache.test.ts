import { describe, expect, it } from 'vitest'
import {
  collectExecutionModes,
  collectWorktreePaths,
} from './initial-data-cache'

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

  it('collects persisted execution modes from reconnect session payloads', () => {
    expect(
      collectExecutionModes({
        sessionsByWorktree: {
          'worktree-1': {
            sessions: [
              { id: 'session-yolo', selected_execution_mode: 'yolo' },
              { id: 'session-plan', selected_execution_mode: 'plan' },
              { id: 'session-missing' },
              { id: 'session-invalid', selected_execution_mode: 'invalid' },
            ],
          },
        },
        activeSessions: {
          'active-build': {
            id: 'active-build',
            selected_execution_mode: 'build',
          },
        },
      })
    ).toEqual({
      'session-yolo': 'yolo',
      'session-plan': 'plan',
      'active-build': 'build',
    })
  })
})
