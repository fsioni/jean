import type { SkillConversationContext } from './skill-conversation-context'

/** Suggestions are optional shortcuts, never evidence or a pipeline state. */
export function suggestWorktreeSkills(
  state: {
    hasPr: boolean
    dirty: boolean
    ci?: string
    fresh: boolean
    localChangesKnown?: boolean
  },
  context?: SkillConversationContext
): string[] {
  if (
    !context ||
    context.outcome === 'blocked' ||
    context.outcome === 'accepted'
  )
    return []
  if (context.skill === 'comment-tester') return []
  if (context.outcome === 'needs_correction') return ['ticket-fix']
  if (state.localChangesKnown === false) return []
  if (context.outcome === 'ready_to_publish') return ['feature-flow']
  if (context.skill === 'clickup-review' || context.skill === 'design-review') {
    if (
      context.outcome === 'ci_passed' ||
      context.outcome === 'ready_for_acceptance'
    )
      return state.hasPr && !state.dirty
        ? ['preview-acceptance']
        : ['feature-flow']
    // Older replies have no structured outcome: offer alternatives, not an invented verdict.
    return [
      'ticket-fix',
      ...(state.hasPr && !state.dirty
        ? ['preview-acceptance']
        : ['feature-flow']),
    ]
  }
  if (state.fresh && ['failure', 'error'].includes(state.ci ?? ''))
    return ['repair-jenkins-branch']
  if (state.dirty || !state.hasPr) return ['feature-flow']
  if (context.skill === 'preview-acceptance') return ['clickup-review']
  if (
    [
      'ticket-fix',
      'feature-flow',
      'repair-jenkins-branch',
      'relance-jenkins-push-vide',
    ].includes(context.skill)
  )
    return ['preview-acceptance']
  return []
}
