/**
 * Pure decision logic for the middle-click close of a worktree row or a
 * conversation (session) row.
 *
 * Kept separate from the heavy `WorktreeItem` component so the branching matrix
 * (confirmation on/off, last vs. multiple sessions, empty vs. non-empty) is
 * unit-testable without rendering the full store/query tree.
 */

export type WorktreeCloseDecision = 'confirm' | 'close'

/**
 * A middle-click on a worktree row confirms before closing unless
 * `confirm_session_close` is explicitly disabled (undefined defaults to on).
 */
export function decideWorktreeMiddleClose(
  confirmSessionClose: boolean | undefined
): WorktreeCloseDecision {
  return confirmSessionClose === false ? 'close' : 'confirm'
}

export type SessionCloseDecision = 'confirm' | 'delete'

/**
 * A middle-click on a conversation row deletes it, mirroring the session-tab
 * middle-click: confirm only when removing the last (non-empty) session of the
 * worktree and confirmation is enabled.
 */
export function decideSessionMiddleClose(params: {
  activeSessionCount: number
  sessionIsEmpty: boolean
  confirmSessionClose: boolean | undefined
}): SessionCloseDecision {
  const { activeSessionCount, sessionIsEmpty, confirmSessionClose } = params
  const isLastSession = activeSessionCount <= 1
  if (isLastSession && confirmSessionClose !== false && !sessionIsEmpty) {
    return 'confirm'
  }
  return 'delete'
}
