import type { ChatMessage } from '@/types/chat'

type MessageRoleOnly = Pick<ChatMessage, 'role'>

export interface CompactHistoryWindow {
  /** First message index shown while compact history is collapsed. */
  startIndex: number
  /** Number of older user prompts hidden before startIndex. */
  hiddenPromptCount: number
}

/**
 * In compact mode, show only the current prompt/run by default.
 *
 * A run starts at the latest user message. If a recovered/partial session has
 * no user message, keep the latest message visible so the chat never blanks.
 */
export function getCurrentPromptWindow(
  messages: readonly MessageRoleOnly[]
): CompactHistoryWindow {
  if (messages.length === 0) {
    return { startIndex: 0, hiddenPromptCount: 0 }
  }

  let startIndex = messages.length - 1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      startIndex = i
      break
    }
  }

  let hiddenPromptCount = 0
  for (let i = 0; i < startIndex; i++) {
    if (messages[i]?.role === 'user') hiddenPromptCount++
  }

  return { startIndex, hiddenPromptCount }
}

export function remapIndexForWindow(index: number, startIndex: number): number {
  return index >= startIndex ? index - startIndex : -1
}
