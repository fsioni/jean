import { describe, expect, it } from 'vitest'

import { buildReleaseNotesSessionPrompt } from './release-notes-prompt'

describe('buildReleaseNotesSessionPrompt', () => {
  it('interpolates the target PR number', () => {
    const prompt = buildReleaseNotesSessionPrompt(123)

    expect(prompt).toContain('PR_NUMBER = 123')
    expect(prompt).toContain('Update PR #123 now.')
  })

  it('requires release-command style branch freshness before gathering data', () => {
    const prompt = buildReleaseNotesSessionPrompt(123)

    expect(prompt).toContain('Identify the current branch name')
    expect(prompt).toContain('comparison branch')
    expect(prompt).toContain('git fetch origin')
    expect(prompt).toContain('git pull origin <current-branch>')
    expect(prompt).toContain(
      'git fetch origin <comparison-branch>:<comparison-branch>'
    )
  })

  it('requires merged PR and closing keyword evidence like the release command', () => {
    const prompt = buildReleaseNotesSessionPrompt(123)

    expect(prompt).toContain("commits in this branch that aren't in")
    expect(prompt).toContain('For each commit, check if it is from a merged PR')
    expect(prompt).toContain(
      'For each merged PR, also check its git commit history'
    )
    expect(prompt).toContain('PR descriptions AND commit messages')
    expect(prompt).toContain('close/closes/closed')
    expect(prompt).toContain('fix/fixes/fixed')
    expect(prompt).toContain('resolve/resolves/resolved')
  })

  it('uses the release-command output categories and reference rules while avoiding self refs', () => {
    const prompt = buildReleaseNotesSessionPrompt(123)

    expect(prompt).toContain('### Security & Fixes')
    expect(prompt).toContain('### New Services & Templates')
    expect(prompt).toContain('### Improvements')
    expect(prompt).toContain(
      'Include all new service templates and one-click services added'
    )
    expect(prompt).toContain('For each line item, show the source PR number')
    expect(prompt).toContain(
      'Do not include the target PR number as a self-reference'
    )
    expect(prompt).toContain('(#234, fixes #456, #789)')
    expect(prompt).toContain('(fixes #456, #789)')
  })
})
