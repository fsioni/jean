import type { Session } from '@/types/chat'

export function isReusableWorkflowInvestigationSession(
  session: Session
): boolean {
  return (
    !session.archived_at &&
    !session.is_reviewing &&
    !session.name.startsWith('Code Review') &&
    (session.message_count === 0 || session.message_count == null)
  )
}
