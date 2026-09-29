/** Prefix Jean sends to Codex in place of `/goal <objective>`. */
export const CODEX_GOAL_TURN_PREFIX =
  'Complete this goal in the current turn:\n\n'

/**
 * Returns the objective when a user message set a goal: either the `/goal
 * <objective>` text (Claude) or Jean's rewritten Codex goal turn.
 */
export function getGoalObjective(content: string): string | null {
  const text = content.trim()
  let objective: string | null = null
  if (/^\/goal(\s|$)/.test(text)) {
    objective = text.replace(/^\/goal\s*/, '')
  } else if (text.startsWith(CODEX_GOAL_TURN_PREFIX.trim())) {
    objective = text.slice(CODEX_GOAL_TURN_PREFIX.trim().length)
  }
  return objective?.trim() || null
}
