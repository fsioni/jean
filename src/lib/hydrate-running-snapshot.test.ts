import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

import { useChatStore } from '@/store/chat-store'
import type { ChatMessage } from '@/types/chat'
import { hydrateRunningSnapshot } from './hydrate-running-snapshot'

const assistantMessage = (
  overrides: Partial<ChatMessage> = {}
): ChatMessage => ({
  id: 'running-session-1',
  session_id: 'session-1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  tool_calls: [],
  content_blocks: [],
  ...overrides,
})

describe('hydrateRunningSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)

    useChatStore.setState({
      sendingSessionIds: {},
      streamingContents: {},
      streamingContentBlocks: {},
      activeToolCalls: {},
    })
  })

  it('skips hydration while sending by default', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [{ type: 'text', text: 'partial output' }],
      })
    )

    expect(
      useChatStore.getState().streamingContentBlocks['session-1']
    ).toBeUndefined()
  })

  it('hydrates running snapshots during reconnect when explicitly allowed', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
        ],
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status' },
          },
        ],
      }),
      { allowWhileSending: true }
    )

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
      ]
    )
    expect(useChatStore.getState().activeToolCalls['session-1']).toEqual([
      {
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'rtk git status' },
      },
    ])
  })
})
