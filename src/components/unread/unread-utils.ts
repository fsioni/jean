import type { Session } from '@/types/chat'

export const FINISHED_UNREAD_STATUSES = ['completed', 'cancelled', 'crashed']

/** Check if a session counts as "unread" — has unseen activity */
export function isUnreadSession(session: Session): boolean {
  if (session.archived_at) return false

  const hasFinishedRun =
    session.last_run_status &&
    FINISHED_UNREAD_STATUSES.includes(session.last_run_status)
  const isWaiting = session.waiting_for_input
  const isReviewing = session.is_reviewing

  if (!hasFinishedRun && !isWaiting && !isReviewing) return false

  if (!session.last_opened_at) return true
  return session.last_opened_at < session.updated_at
}
