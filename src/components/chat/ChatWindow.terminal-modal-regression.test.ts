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

  it('auto-restores terminal sessions silently without marking them opened', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).toMatch(
      /reconnectNativeCliSession\s*\(\s*session\s*,\s*activeWorktreeId/
    )
    expect(source).toMatch(/openModal:\s*false/)
    expect(source).toMatch(/showToast:\s*false/)
    expect(source).toMatch(/markOpened:\s*false/)
    expect(source).toContain("session.primary_surface === 'terminal'")
  })

  it('guards terminal auto-restore against session switches and duplicate spawns', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).toMatch(/if\s*\(\s*isSessionSwitching\s*\)\s*return/)
    expect(source).toMatch(
      /if\s*\(\s*autoReconnectingRef\.current\.has\s*\(\s*deferredSessionId\s*\)\s*\)\s*return/
    )
    expect(source).toMatch(
      /autoReconnectingRef\.current\.add\s*\(\s*sessionId\s*\)/
    )
    expect(source).toMatch(
      /autoReconnectingRef\.current\.delete\s*\(\s*sessionId\s*\)/
    )
  })

  it('shows a safe recovery state instead of an empty chat for legacy sessions', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).toContain('isTerminalAwaitingReconnect')
    expect(source).toContain('Terminal session needs to be reconnected')
    expect(source).toContain('Choose native session')
  })
})
