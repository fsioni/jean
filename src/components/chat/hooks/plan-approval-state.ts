import { useChatStore } from '@/store/chat-store'

/**
 * Clear transient streaming/approval state before sending an execution turn.
 *
 * The approved plan remains visible in the persisted assistant message. Keeping
 * the in-memory plan tool/content blocks here causes the next build/yolo tool
 * stream to append into the previous planning timeline.
 */
export function clearPlanApprovalTransientState(sessionId: string) {
  const store = useChatStore.getState()
  store.clearToolCalls(sessionId)
  store.clearStreamingContentBlocks(sessionId)
  store.setSessionReviewing(sessionId, false)
  store.setWaitingForInput(sessionId, false)
  store.setPendingPlanMessageId(sessionId, null)
}
