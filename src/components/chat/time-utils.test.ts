import { describe, expect, it } from 'vitest'
import { formatDuration, getAssistantDurationMs } from './time-utils'
import type { ChatMessage } from '@/types/chat'

describe('formatDuration', () => {
  it('formats sub-minute durations as seconds only', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(23_999)).toBe('23s')
  })

  it('formats minute boundaries as mm:ss', () => {
    expect(formatDuration(60_000)).toBe('01:00')
    expect(formatDuration(145_000)).toBe('02:25')
  })
})

describe('getAssistantDurationMs', () => {
  const messages: ChatMessage[] = [
    {
      id: 'user-1',
      session_id: 'session-1',
      role: 'user',
      content: 'Prompt',
      timestamp: 100,
      tool_calls: [],
      content_blocks: [],
    },
    {
      id: 'assistant-1',
      session_id: 'session-1',
      role: 'assistant',
      content: 'Reply',
      timestamp: 123,
      tool_calls: [],
      content_blocks: [],
    },
  ]

  it('prefers stored duration for the final assistant message', () => {
    expect(getAssistantDurationMs(messages, 1, 145_000)).toBe(145_000)
  })

  it('falls back to user-to-assistant timestamp delta', () => {
    expect(getAssistantDurationMs(messages, 1, null)).toBe(23_000)
  })

  it('does not produce duration for user messages', () => {
    expect(getAssistantDurationMs(messages, 0, 145_000)).toBeNull()
  })
})
