import { describe, expect, it } from 'vitest'
import { CODEX_GOAL_TURN_PREFIX, getGoalObjective } from './goal-utils'

describe('getGoalObjective', () => {
  it('reads the objective from a /goal message', () => {
    expect(getGoalObjective('/goal ship the feature\nwith tests')).toBe(
      'ship the feature\nwith tests'
    )
  })

  it('reads the objective from a Codex goal turn', () => {
    expect(getGoalObjective(`${CODEX_GOAL_TURN_PREFIX}ship it`)).toBe('ship it')
  })

  it('returns null for other messages', () => {
    expect(getGoalObjective('/goal')).toBeNull()
    expect(getGoalObjective('/goalie keeper')).toBeNull()
    expect(getGoalObjective('what is the goal?')).toBeNull()
  })
})
