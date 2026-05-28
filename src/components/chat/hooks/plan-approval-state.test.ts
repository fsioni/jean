import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

import { useChatStore } from '@/store/chat-store'
import { clearPlanApprovalTransientState } from './plan-approval-state'

describe('clearPlanApprovalTransientState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      activeToolCalls: {},
      streamingContentBlocks: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      pendingPlanMessageIds: {},
    })
  })

  it('clears preserved Codex plan tool state before execution tools stream', () => {
    const sessionId = 'session-codex-plan'
    const store = useChatStore.getState()

    store.addToolCall(sessionId, {
      id: 'plan-tool',
      name: 'CodexPlan',
      input: { plan: 'Plan:\n- fix bug' },
    })
    store.addToolBlock(sessionId, 'plan-tool')
    store.setSessionReviewing(sessionId, true)
    store.setWaitingForInput(sessionId, true)
    store.setPendingPlanMessageId(sessionId, 'plan-message')

    clearPlanApprovalTransientState(sessionId)

    const next = useChatStore.getState()
    expect(next.activeToolCalls[sessionId]).toBeUndefined()
    expect(next.streamingContentBlocks[sessionId]).toBeUndefined()
    expect(next.reviewingSessions[sessionId]).toBeUndefined()
    expect(next.waitingForInputSessionIds[sessionId]).toBeUndefined()
    expect(next.pendingPlanMessageIds[sessionId]).toBeUndefined()
    expect(next.getPendingPlanMessageId(sessionId)).toBeNull()
  })
})
