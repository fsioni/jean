import { describe, expect, it } from 'vitest'
import { shouldSuppressAutoFixConflictNotification } from './worktree-conflict-events'

describe('worktree conflict events', () => {
  it('suppresses auto-fix conflict notifications', () => {
    expect(
      shouldSuppressAutoFixConflictNotification({ origin: 'auto_fix' })
    ).toBe(true)
  })

  it('keeps manual conflict notifications visible', () => {
    expect(
      shouldSuppressAutoFixConflictNotification({ origin: 'manual' })
    ).toBe(false)
    expect(shouldSuppressAutoFixConflictNotification({})).toBe(false)
  })
})
