import { describe, expect, it } from 'vitest'
import {
  getCurrentPromptWindow,
  remapIndexForWindow,
} from './compact-history-window'

const user = { role: 'user' as const }
const assistant = { role: 'assistant' as const }

describe('getCurrentPromptWindow', () => {
  it('returns an empty window for empty message lists', () => {
    expect(getCurrentPromptWindow([])).toEqual({
      startIndex: 0,
      hiddenPromptCount: 0,
    })
  })

  it('starts at the only user prompt when the current run has no answer yet', () => {
    expect(getCurrentPromptWindow([user])).toEqual({
      startIndex: 0,
      hiddenPromptCount: 0,
    })
  })

  it('starts at the latest user prompt and hides older prompts', () => {
    expect(
      getCurrentPromptWindow([user, assistant, user, assistant, user])
    ).toEqual({
      startIndex: 4,
      hiddenPromptCount: 2,
    })
  })

  it('keeps the latest assistant visible when no user prompt exists', () => {
    expect(getCurrentPromptWindow([assistant, assistant])).toEqual({
      startIndex: 1,
      hiddenPromptCount: 0,
    })
  })
})

describe('remapIndexForWindow', () => {
  it('hides indices before the compact window', () => {
    expect(remapIndexForWindow(2, 4)).toBe(-1)
  })

  it('remaps visible indices into the sliced message list', () => {
    expect(remapIndexForWindow(5, 4)).toBe(1)
  })
})
