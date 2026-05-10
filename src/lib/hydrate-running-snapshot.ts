import type { ChatMessage } from '@/types/chat'
import { useChatStore } from '@/store/chat-store'
import { coalesceContentBlocks } from '@/components/chat/tool-call-utils'

/**
 * Rebuild `streamingContentBlocks` for a running assistant snapshot so the
 * reopened view matches what live streaming would produce.
 *
 * Backend `parse_run_to_message` emits one `ContentBlock::Text` per Claude CLI
 * stream-json delta. Live streaming merges those via `addTextBlock`, but a
 * snapshot loaded from disk or delivered to a web-access client arrives with
 * the deltas still split. Route them through the same invariant here.
 *
 * Safe to call from any session-open path — reloads, web access click-to-open,
 * sidebar navigation. No-op when the store already has blocks for the session.
 */
export function hydrateRunningSnapshot(
  sessionId: string,
  lastMsg: ChatMessage,
  options: { allowWhileSending?: boolean } = {}
): void {
  const store = useChatStore.getState()
  // Defense in depth: never hydrate while this client is mid-send or the store
  // already has live streaming blocks/tool calls for the session. Wholesale
  // injection mid-stream double-renders the assistant bubble.
  // Note: streamingContents is NOT checked here because App.tsx auto-resume
  // intentionally seeds it before calling hydrate.
  if (!options.allowWhileSending && store.sendingSessionIds[sessionId]) return
  if (store.streamingContentBlocks[sessionId]?.length) return
  if (store.activeToolCalls[sessionId]?.length) return

  const normalized = coalesceContentBlocks(lastMsg.content_blocks ?? [])
  for (const block of normalized) {
    if (block.type === 'text') {
      store.addTextBlock(sessionId, block.text)
    } else if (block.type === 'tool_use') {
      store.addToolBlock(sessionId, block.tool_call_id)
    } else if (block.type === 'thinking') {
      store.addThinkingBlock(sessionId, block.thinking)
    }
  }

  for (const tc of lastMsg.tool_calls ?? []) {
    store.addToolCall(sessionId, tc)
  }
}
