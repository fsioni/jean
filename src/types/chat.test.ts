import { describe, expect, it } from 'vitest'
import { hasQuestionAnswerOutput, normalizeCodexQuestions } from './chat'

describe('hasQuestionAnswerOutput', () => {
  it('returns false for Claude blocking-tool error output', () => {
    expect(hasQuestionAnswerOutput('Answer questions?')).toBe(false)
    expect(hasQuestionAnswerOutput('Error: Answer questions?')).toBe(false)
  })

  it('returns true for persisted JSON answers', () => {
    expect(
      hasQuestionAnswerOutput(
        JSON.stringify([{ questionIndex: 0, selectedOptions: [1] }])
      )
    ).toBe(true)
  })

  it('returns true for non-JSON backend answer output', () => {
    expect(hasQuestionAnswerOutput('Backyard birds')).toBe(true)
  })
})

describe('normalizeCodexQuestions', () => {
  it('normalizes Codex request_user_input questions for Jean question cards', () => {
    expect(
      normalizeCodexQuestions([
        {
          id: 'scope',
          header: 'Scope',
          question: 'Which scope should I use?',
          options: [
            { label: 'Backend', description: 'Rust only' },
            { label: 'Frontend' },
          ],
          isOther: true,
          isSecret: false,
        },
      ])
    ).toEqual([
      {
        header: 'Scope',
        question: 'Which scope should I use?',
        multiSelect: false,
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Backend', description: 'Rust only' },
          { label: 'Frontend', description: undefined },
        ],
      },
    ])
  })
})
