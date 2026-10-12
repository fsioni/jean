import { extractSkillPaths } from './message-content-utils'

export const skillResultPattern = /<!-- jean-skill-result:(\{[^\n]*\}) -->/g
const outcomes = new Set([
  'needs_correction',
  'ready_to_publish',
  'ready_for_acceptance',
  'ci_passed',
  'accepted',
  'blocked',
])
const skills = new Set([
  'clickup-review',
  'ticket-fix',
  'feature-flow',
  'preview-acceptance',
  'repair-jenkins-branch',
  'relance-jenkins-push-vide',
  'design-review',
  'comment-tester',
])
export interface SkillConversationContext {
  skill: string
  outcome?: string
}

/** Optional recommendations only. A marker never authorizes or executes an action. */
export function readSkillConversationContext(
  messages: { role: string; content: string; cancelled?: boolean }[]
): SkillConversationContext | undefined {
  let context: SkillConversationContext | undefined
  let explicitInvocation = false
  let hasUserRequest = false
  let hasCompletedReply = false
  for (const message of messages) {
    if (message.role === 'user') {
      hasUserRequest = true
      hasCompletedReply = false
      const attached = extractSkillPaths(message.content)
        .map(path => path.replace(/\\/g, '/').split('/').at(-2))
        .filter((name): name is string => Boolean(name && skills.has(name)))
      const typed = [...message.content.matchAll(/(?:^|\s)\$([a-z-]+)\b/g)]
        .map(match => match[1])
        .filter((name): name is string => Boolean(name && skills.has(name)))
      const invoked = [...attached, ...typed].at(-1)
      explicitInvocation = Boolean(invoked)
      context = invoked ? { skill: invoked } : undefined
      continue
    }
    if (message.role !== 'assistant' || !hasUserRequest) continue
    hasCompletedReply = !message.cancelled
    if (message.cancelled) continue
    for (const match of message.content.matchAll(
      new RegExp(skillResultPattern.source, 'g')
    )) {
      try {
        const result = JSON.parse(match[1] ?? '')
        if (
          result.v === 1 &&
          skills.has(result.skill) &&
          (!explicitInvocation || result.skill === context?.skill) &&
          outcomes.has(result.outcome)
        )
          context = { skill: result.skill, outcome: result.outcome }
      } catch {
        /* An incomplete/malformed marker is not a result. */
      }
    }
  }
  return hasCompletedReply ? context : undefined
}
