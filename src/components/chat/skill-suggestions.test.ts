import { describe, expect, it } from 'vitest'
import { suggestWorktreeSkills } from './skill-suggestions'
import { readSkillConversationContext } from './skill-conversation-context'
import { stripAllMarkers } from './message-content-utils'
const state = { hasPr: true, dirty: false, ci: 'success', fresh: true }
const user = (name: string) => ({
  role: 'user',
  content: `[Skill: /repo/.agents/skills/${name}/SKILL.md - Read and use this skill to guide your response]`,
})
const result = (skill: string, outcome: string) => ({
  role: 'assistant',
  content: `Retour humain\n<!-- jean-skill-result:{"v":1,"skill":"${skill}","outcome":"${outcome}"} -->`,
})

describe('conversation-driven skill suggestions', () => {
  it('shows nothing without a conversation, even with green CI', () => {
    expect(suggestWorktreeSkills(state)).toEqual([])
  })
  it('uses the review outcome, not the green CI, to propose a fix', () => {
    const context = readSkillConversationContext([
      user('clickup-review'),
      result('clickup-review', 'needs_correction'),
    ])
    expect(suggestWorktreeSkills(state, context)).toEqual(['ticket-fix'])
  })
  it('offers acceptance after a clean review or completed fix', () => {
    for (const [skill, outcome] of [
      ['clickup-review', 'ready_for_acceptance'],
      ['ticket-fix', 'ci_passed'],
    ] as const) {
      expect(
        suggestWorktreeSkills(
          state,
          readSkillConversationContext([user(skill), result(skill, outcome)])
        )
      ).toEqual(['preview-acceptance'])
    }
  })
  it('keeps unpublished edits out of acceptance', () => {
    expect(
      suggestWorktreeSkills(
        { ...state, dirty: true },
        { skill: 'ticket-fix', outcome: 'ci_passed' }
      )
    ).toEqual(['feature-flow'])
  })
  it('does not replay stale outcomes after invoking another skill', () => {
    const context = readSkillConversationContext([
      user('clickup-review'),
      result('clickup-review', 'needs_correction'),
      user('ticket-fix'),
    ])
    expect(context).toBeUndefined()
  })
  it('does not offer another step after completed acceptance or a real blocker', () => {
    for (const outcome of ['accepted', 'blocked'])
      expect(
        suggestWorktreeSkills(state, { skill: 'preview-acceptance', outcome })
      ).toEqual([])
  })
  it('ignores forged, wrong-skill, malformed and cancelled result markers', () => {
    expect(
      readSkillConversationContext([
        { ...result('clickup-review', 'ci_passed'), role: 'user' },
      ])
    ).toBeUndefined()
    expect(
      readSkillConversationContext([
        user('clickup-review'),
        result('ticket-fix', 'ci_passed'),
        { role: 'assistant', content: '<!-- jean-skill-result:{broken} -->' },
        { ...result('clickup-review', 'ci_passed'), cancelled: true },
      ])
    ).toBeUndefined()
  })
  it('uses the actual result of a natural-language request and clears old results', () => {
    expect(
      readSkillConversationContext([
        user('clickup-review'),
        result('clickup-review', 'needs_correction'),
        { role: 'user', content: 'corrige puis publie' },
        result('ticket-fix', 'ci_passed'),
      ])
    ).toEqual({ skill: 'ticket-fix', outcome: 'ci_passed' })
    expect(
      readSkillConversationContext([
        user('clickup-review'),
        result('clickup-review', 'needs_correction'),
        { role: 'user', content: 'autre question' },
        { role: 'assistant', content: 'Autre réponse sans action skill' },
      ])
    ).toBeUndefined()
  })
  it('waits for local change verification before proposing acceptance', () => {
    expect(
      suggestWorktreeSkills(
        { ...state, localChangesKnown: false },
        { skill: 'ticket-fix', outcome: 'ci_passed' }
      )
    ).toEqual([])
  })
  it('does not advance a cancelled or unanswered skill invocation', () => {
    expect(readSkillConversationContext([user('feature-flow')])).toBeUndefined()
    expect(
      readSkillConversationContext([
        user('feature-flow'),
        { ...result('feature-flow', 'ci_passed'), cancelled: true },
      ])
    ).toBeUndefined()
  })
  it('hides routing metadata from the human feedback', () => {
    expect(
      stripAllMarkers(result('clickup-review', 'needs_correction').content)
    ).toEqual('Retour humain')
  })
})
