import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('terminal primary surface modal regression', () => {
  it('keeps ChatWindow global modals mounted when terminal is primary surface', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).not.toContain(
      "if (primarySurface === 'terminal' && activeSessionId && sessionTerminalId)"
    )

    const terminalSurfaceIndex = source.indexOf('{isTerminalPrimarySurface ? (')
    const gitDiffModalIndex = source.indexOf('<GitDiffModal')

    expect(terminalSurfaceIndex).toBeGreaterThan(-1)
    expect(gitDiffModalIndex).toBeGreaterThan(terminalSurfaceIndex)
  })

  it('keeps ChatWindow mounted in session modals when terminal is primary surface', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).not.toContain("primarySurface !== 'terminal'")
    expect(source).not.toContain("primarySurface === 'terminal' &&")
    expect(source).toContain('{currentSessionId ? (')
    expect(source).toContain('<ChatWindow')
  })
})
