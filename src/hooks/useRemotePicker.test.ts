import { describe, expect, it } from 'vitest'
import { pushNeedsRemotePicker } from './useRemotePicker'

describe('pushNeedsRemotePicker', () => {
  it('does not ask for a remote for PR worktrees because the backend resolves the PR target', () => {
    expect(pushNeedsRemotePicker(426)).toBe(false)
  })

  it('asks for a remote for non-PR worktrees', () => {
    expect(pushNeedsRemotePicker(undefined)).toBe(true)
    expect(pushNeedsRemotePicker(null)).toBe(true)
  })
})
