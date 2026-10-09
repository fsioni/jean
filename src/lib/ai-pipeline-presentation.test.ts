import { describe, expect, it } from 'vitest'
import type { ValidationExecution } from '@/types/ai-pipeline'
import {
  selectWorktreeValidation,
  validationStepLabel,
  validationSessionIds,
} from './ai-pipeline-presentation'

function execution(
  overrides: Partial<ValidationExecution> = {}
): ValidationExecution {
  return {
    id: 'latest',
    worktree_id: 'w1',
    status: 'running',
    paused: false,
    updated_at: '2026-10-07T10:00:00Z',
    created_at: '2026-10-07T09:00:00Z',
    ...overrides,
  } as ValidationExecution
}

describe('pipeline presentation', () => {
  it('selects one active execution over an older blocked duplicate', () => {
    const running = execution()
    expect(
      selectWorktreeValidation(
        [
          execution({
            id: 'old',
            status: 'blocked',
            updated_at: '2026-10-07T08:00:00Z',
          }),
          running,
        ],
        'w1'
      )
    ).toBe(running)
  })
  it('uses creation order rather than a refresh or status priority', () => {
    const running = execution()
    expect(
      selectWorktreeValidation(
        [
          running,
          execution({
            id: 'ready',
            status: 'ready',
            created_at: '2026-10-06T09:00:00Z',
            updated_at: '2026-10-07T12:00:00Z',
          }),
        ],
        'w1'
      )
    ).toBe(running)
  })
  it('does not present a superseded execution as current', () => {
    const current = execution({ status: 'ready' })
    expect(
      selectWorktreeValidation(
        [
          execution({
            id: 'old',
            superseded_by: current.id,
            updated_at: '2026-10-07T12:00:00Z',
          }),
          current,
        ],
        'w1'
      )
    ).toBe(current)
  })
  it('falls back to most recent non-active execution and scopes by worktree', () => {
    const ready = execution({ status: 'ready' })
    expect(
      selectWorktreeValidation(
        [
          execution({ worktree_id: 'w2' }),
          ready,
          execution({
            id: 'failed',
            status: 'failed',
            created_at: '2026-10-06T09:00:00Z',
            updated_at: '2026-10-07T08:00:00Z',
          }),
        ],
        'w1'
      )
    ).toBe(ready)
    expect(selectWorktreeValidation([ready], 'missing')).toBeNull()
  })
  it('does not mutate the persisted list while sorting', () => {
    const list = [
      execution({ id: 'old', updated_at: '2026-10-07T08:00:00Z' }),
      execution(),
    ]
    selectWorktreeValidation(list, 'w1')
    expect(list[0]?.id).toBe('old')
  })
  it('labels all current steps without a fixed progression assumption', () => {
    expect(validationStepLabel('correction')).toBe('Correction')
    expect(validationStepLabel('acceptance')).toBe('Recette')
    expect(validationStepLabel('create_pr')).toBe('Création de PR')
  })
  it('groups only explicitly attributed sessions, including historical executions', () => {
    const old = execution({
      id: 'old',
      superseded_by: 'latest',
      agent_sessions: [
        { session_id: 'review-1', step: 'review', attempt_id: 'a1' },
      ],
    })
    const current = execution({
      active_session_id: 'correction-1',
      agent_sessions: [
        { session_id: 'correction-1', step: 'correction', attempt_id: 'a2' },
      ],
    })
    const other = execution({ worktree_id: 'w2', active_session_id: 'other' })
    expect([...validationSessionIds([old, current, other], 'w1')]).toEqual([
      'review-1',
      'correction-1',
    ])
  })
})

it('never treats a ready label without current proofs as verified', async () => {
  const { hasCurrentValidationProof } =
    await import('./ai-pipeline-presentation')
  expect(
    hasCurrentValidationProof(
      execution({
        status: 'ready',
        requirements: [],
        evidence: [],
        effects: [],
        defects: [],
      })
    )
  ).toBe(false)
})

it('preserves access to history when the replacement is not in the loaded list', () => {
  const historical = execution({ superseded_by: 'missing' })
  expect(selectWorktreeValidation([historical], 'w1')).toBe(historical)
})

it('keeps a newer failed correction current ahead of ready history', () => {
  const failed = execution({
    id: 'failed',
    status: 'failed',
    created_at: '2026-10-08',
  })
  const ready = execution({
    id: 'ready',
    status: 'ready',
    created_at: '2026-10-01',
  })
  expect(selectWorktreeValidation([ready, failed], 'w1')).toBe(failed)
})

it('shows the actual revisited route, not a fixed stage percentage', async () => {
  const { validationRecentSteps } = await import('./ai-pipeline-presentation')
  expect(
    validationRecentSteps(
      execution({
        step: 'review',
        transitions: [
          { step: 'acceptance' },
          { step: 'correction' },
          { step: 'correction' },
        ] as ValidationExecution['transitions'],
      })
    )
  ).toEqual(['acceptance', 'correction', 'review'])
})
it('does not count a passed label with stale evidence as confirmed progress', async () => {
  const { validationProofSummary } = await import('./ai-pipeline-presentation')
  expect(
    validationProofSummary(
      execution({
        head_commit: 'head',
        requirements: [
          {
            id: 'r',
            label: 'Recette',
            mandatory: true,
            status: 'passed',
            evidence_ids: ['e'],
          },
        ],
        evidence: [
          {
            id: 'e',
            label: 'preuve',
            kind: 'test',
            value: 'OK',
            commit: 'head',
            stale: true,
          },
        ],
      })
    )
  ).toEqual({ confirmed: 0, total: 1 })
})
