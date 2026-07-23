import { describe, expect, it } from 'vitest'
import {
  getStackedBaseBranch,
  shouldShowWorktreeBranchBadge,
} from './worktree-branch-badge'

describe('getStackedBaseBranch', () => {
  it('hides the badge when an existing branch is opened directly', () => {
    expect(
      getStackedBaseBranch(
        'v5-parallel-inertia-react',
        'v5-parallel-inertia-react',
        'main'
      )
    ).toBeNull()
  })

  it('hides the default branch badge', () => {
    expect(getStackedBaseBranch('main', 'feature', 'main')).toBeNull()
  })

  it('returns a non-default source branch for a derived worktree', () => {
    expect(
      getStackedBaseBranch('feature-parent', 'feature-child', 'main')
    ).toBe('feature-parent')
  })

  it('qualifies the base with the remote it was picked from', () => {
    // Without the remote this would be hidden as "just the default branch",
    // which on a multi-remote project loses which repository it came from.
    expect(getStackedBaseBranch('main', 'feature', 'main', 'fork')).toBe(
      'fork/main'
    )
  })

  it('qualifies a non-default base branch too', () => {
    expect(
      getStackedBaseBranch(
        'feature-parent',
        'feature-child',
        'main',
        'upstream'
      )
    ).toBe('upstream/feature-parent')
  })

  it('ignores the remote when there is no base branch', () => {
    expect(
      getStackedBaseBranch(undefined, 'feature', 'main', 'fork')
    ).toBeNull()
  })
})

describe('shouldShowWorktreeBranchBadge', () => {
  it('hides branch metadata that only repeats the worktree name', () => {
    expect(
      shouldShowWorktreeBranchBadge({
        displayBranch: 'v5-parallel-inertia-react',
        worktreeName: 'v5-parallel-inertia-react',
        stackedBaseBranch: null,
      })
    ).toBe(false)
  })

  it('shows meaningful source branch metadata', () => {
    expect(
      shouldShowWorktreeBranchBadge({
        displayBranch: 'feature-child',
        worktreeName: 'feature-child',
        stackedBaseBranch: 'feature-parent',
      })
    ).toBe(true)
  })

  it('keeps PR context visible', () => {
    expect(
      shouldShowWorktreeBranchBadge({
        displayBranch: 'feature',
        worktreeName: 'feature',
        stackedBaseBranch: null,
        prNumber: 42,
      })
    ).toBe(true)
  })
})
