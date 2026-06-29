import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/types/chat'
import { findLatestRecapSection } from './recap-utils'

function assistantMessage(id: string, text: string): ChatMessage {
  return {
    id,
    session_id: 'session-1',
    role: 'assistant',
    content: text,
    timestamp: 1,
    tool_calls: [],
    content_blocks: [{ type: 'text', text }],
  }
}

describe('recap-utils', () => {
  it('finds the latest assistant recap section', () => {
    const recap = findLatestRecapSection([
      assistantMessage('old', '## Recap\n\nOld summary'),
      assistantMessage('new', 'Done.\n\n## Recap\n\nNew summary\n\n- caveat'),
    ])

    expect(recap).toBe('## Recap\n\nNew summary\n\n- caveat')
  })

  it('returns null when a session has no recap', () => {
    expect(findLatestRecapSection([assistantMessage('msg', 'No recap')])).toBe(
      null
    )
  })
})
