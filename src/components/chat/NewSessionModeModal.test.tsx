import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { NewSessionModeModal } from './NewSessionModeModal'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'

const mutate = vi.fn()

vi.mock('@/services/chat', () => ({
  useCreateSession: () => ({
    mutate,
    isPending: false,
  }),
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliStatus: () => ({
    data: { installed: true, path: '/usr/local/bin/claude' },
    isLoading: false,
  }),
}))

vi.mock('@/services/codex-cli', () => ({
  useCodexCliStatus: () => ({
    data: { installed: true, path: '/usr/local/bin/codex' },
    isLoading: false,
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useOpencodeCliStatus: () => ({
    data: { installed: false, path: null },
    isLoading: false,
  }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useCursorCliStatus: () => ({
    data: { installed: false, path: null },
    isLoading: false,
  }),
}))

describe('NewSessionModeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mutate.mockReset()
    useUIStore.setState({
      newSessionModeTarget: null,
      sessionPrimarySurface: {},
      sessionTerminalIds: {},
    })
    useChatStore.setState({ activeSessionIds: {}, selectedBackends: {} })
    useTerminalStore.setState({
      terminals: {},
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: false,
      terminalPanelOpen: {},
      modalTerminalOpen: {},
    })
  })

  it('defaults Enter to a normal Jean chat session', () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-1' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: 'Enter' })

    expect(mutate).toHaveBeenCalledWith(
      { worktreeId: 'worktree-1', worktreePath: '/tmp/worktree-1' },
      expect.any(Object)
    )
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'session-1'
    )
    expect(useUIStore.getState().sessionPrimarySurface['session-1']).toBe(
      'chat'
    )
  })

  it('opens an installed backend directly in a terminal session', () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string; name: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-terminal-1', name: 'Terminal' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.queryByText('OpenCode')).toBeNull()
    expect(screen.getByText('Terminal')).toBeInTheDocument()
    expect(
      screen.getByTestId('new-session-backend-separator')
    ).toBeInTheDocument()

    fireEvent.keyDown(window, { key: '2' })

    expect(mutate).toHaveBeenCalledWith(
      {
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree-1',
        name: 'Codex',
        backend: 'codex',
      },
      expect.any(Object)
    )
    expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(1)
    expect(
      useTerminalStore.getState().terminals['worktree-1']?.[0]
    ).toMatchObject({
      kind: 'session',
      command: '/usr/local/bin/codex',
      commandArgs: [],
    })
    expect(
      useTerminalStore.getState().activeTerminalIds['worktree-1']
    ).toBeUndefined()
    expect(
      useTerminalStore.getState().terminalPanelOpen['worktree-1'] ?? false
    ).toBe(false)
    expect(useTerminalStore.getState().terminalVisible).toBe(false)
    expect(
      useUIStore.getState().sessionPrimarySurface['session-terminal-1']
    ).toBe('terminal')
    expect(
      useUIStore.getState().sessionTerminalIds['session-terminal-1']
    ).toEqual(expect.any(String))
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'session-terminal-1'
    )
    expect(useChatStore.getState().selectedBackends['session-terminal-1']).toBe(
      'codex'
    )
  })

  it('opens a plain terminal session with shortcut 1', () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string; name: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-plain-terminal-1', name: 'Terminal' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: '1' })

    expect(mutate).toHaveBeenCalledWith(
      {
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree-1',
        name: 'Terminal',
      },
      expect.any(Object)
    )
    expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(1)
    expect(
      useTerminalStore.getState().terminals['worktree-1']?.[0]
    ).toMatchObject({
      kind: 'session',
      command: null,
      commandArgs: [],
      label: 'Terminal',
    })
    expect(
      useTerminalStore.getState().activeTerminalIds['worktree-1']
    ).toBeUndefined()
    expect(
      useTerminalStore.getState().terminalPanelOpen['worktree-1'] ?? false
    ).toBe(false)
    expect(useTerminalStore.getState().terminalVisible).toBe(false)
    expect(
      useUIStore.getState().sessionPrimarySurface['session-plain-terminal-1']
    ).toBe('terminal')
    expect(
      useUIStore.getState().sessionTerminalIds['session-plain-terminal-1']
    ).toEqual(expect.any(String))
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'session-plain-terminal-1'
    )
    expect(
      useChatStore.getState().selectedBackends['session-plain-terminal-1']
    ).toBeUndefined()
  })

  it('marks chat sessions as chat surfaces', () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-chat-1' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: 'Enter' })

    expect(useUIStore.getState().sessionPrimarySurface['session-chat-1']).toBe(
      'chat'
    )
  })
})
