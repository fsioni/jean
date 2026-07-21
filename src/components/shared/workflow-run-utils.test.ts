import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import { isReusableWorkflowInvestigationSession } from './workflow-run-utils'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Session 1',
    order: 0,
    created_at: 0,
    updated_at: 0,
    messages: [],
    message_count: 0,
    ...overrides,
  }
}

describe('isReusableWorkflowInvestigationSession', () => {
  it('does not reuse an active code review session', () => {
    expect(
      isReusableWorkflowInvestigationSession(
        session({ name: 'Code Review', is_reviewing: true })
      )
    ).toBe(false)
  })

  it('does not reuse an idle code review session', () => {
    expect(
      isReusableWorkflowInvestigationSession(
        session({ name: 'Code Review · Codex · gpt-5.6-sol' })
      )
    ).toBe(false)
  })

  it('reuses an unarchived empty chat session', () => {
    expect(isReusableWorkflowInvestigationSession(session())).toBe(true)
  })

  it('does not reuse non-empty or archived chat sessions', () => {
    expect(
      isReusableWorkflowInvestigationSession(session({ message_count: 1 }))
    ).toBe(false)
    expect(
      isReusableWorkflowInvestigationSession(session({ archived_at: 1 }))
    ).toBe(false)
  })
})
