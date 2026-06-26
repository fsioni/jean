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

    expect(source).toContain('reconnectNativeCliSession(session, activeWorktreeId')
    expect(source).toContain('openModal: false')
    expect(source).toContain('showToast: false')
    expect(source).toContain('markOpened: false')
  })

  it('guards terminal auto-restore against session switches and duplicate spawns', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).toContain('if (isSessionSwitching) return')
    expect(source).toContain(
      'if (autoReconnectingRef.current.has(deferredSessionId)) return'
    )
    expect(source).toContain('autoReconnectingRef.current.add(sessionId)')
    expect(source).toContain('autoReconnectingRef.current.delete(sessionId)')
  })
})
