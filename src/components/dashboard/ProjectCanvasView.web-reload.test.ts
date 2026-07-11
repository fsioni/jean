import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ProjectCanvasView web reload recovery', () => {
  const source = readFileSync(
    `${process.cwd()}/src/components/dashboard/ProjectCanvasView.tsx`,
    'utf8'
  )

  it('restores the open session modal and active session', () => {
    expect(source).toContain('consumeWebReloadState(projectId)')
    expect(source).toContain('setActiveSession(')
    expect(source).toContain('setSelectedWorktreeModal({')
  })
})
