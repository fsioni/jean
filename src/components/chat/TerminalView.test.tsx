import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { useTerminalStore } from '@/store/terminal-store'
import { invoke } from '@/lib/transport'
import { SingleTerminalView, TerminalView } from './TerminalView'

const initTerminal = vi.fn().mockResolvedValue(undefined)
const fit = vi.fn()
const focus = vi.fn()

vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
    initTerminal,
    fit,
    focus,
  }),
}))

vi.mock('@/lib/transport', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/terminal-instances', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  disposeTerminal: vi.fn().mockResolvedValue(undefined),
}))

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
}

describe('SingleTerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver
    window.requestAnimationFrame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => {
        callback(0)
        return 0
      })
    useTerminalStore.setState({
      terminals: {
        'worktree-1': [
          {
            id: 'terminal-1',
            worktreeId: 'worktree-1',
            command: 'codex',
            commandArgs: [],
            label: 'Codex',
            kind: 'session',
          },
          {
            id: 'terminal-2',
            worktreeId: 'worktree-1',
            command: 'claude',
            commandArgs: [],
            label: 'Claude',
            kind: 'session',
          },
        ],
      },
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: false,
      terminalPanelOpen: {},
      modalTerminalOpen: {},
    })
  })

  it('does not initialize inactive full-screen terminal sessions', () => {
    render(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive={false}
      />
    )

    expect(initTerminal).not.toHaveBeenCalled()
  })

  it('initializes when the full-screen terminal becomes active', async () => {
    const { rerender } = render(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive={false}
      />
    )

    rerender(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive
      />
    )

    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(1))
  })

  it('initializes the new terminal when switching full-screen session terminals', async () => {
    const { rerender } = render(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive
      />
    )

    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(1))

    rerender(
      <SingleTerminalView
        terminalId="terminal-2"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive
      />
    )

    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(2))
  })
})

describe('TerminalView tab middle-click', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver
    window.requestAnimationFrame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => {
        callback(0)
        return 0
      })
    useTerminalStore.setState({
      terminals: {
        'worktree-1': [
          {
            id: 'terminal-1',
            worktreeId: 'worktree-1',
            command: 'bash',
            commandArgs: [],
            label: 'Terminal 1',
            kind: 'panel',
          },
          {
            id: 'terminal-2',
            worktreeId: 'worktree-1',
            command: 'bash',
            commandArgs: [],
            label: 'Terminal 2',
            kind: 'panel',
          },
        ],
      },
      activeTerminalIds: { 'worktree-1': 'terminal-1' },
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: true,
      terminalPanelOpen: { 'worktree-1': true },
      modalTerminalOpen: {},
    })
  })

  const renderTabBar = () =>
    render(
      <TerminalView worktreeId="worktree-1" worktreePath="/tmp/worktree-1" />
    )

  const getTab = (label: string) => {
    const tab = screen.getByText(label).closest('button')
    if (!tab) throw new Error(`Tab button for "${label}" not found`)
    return tab
  }

  it('closes the tab on middle-click (button 1)', async () => {
    renderTabBar()

    fireEvent(
      getTab('Terminal 1'),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    )

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('stop_terminal', {
        terminalId: 'terminal-1',
      })
    )
    await waitFor(() => {
      const remaining =
        useTerminalStore.getState().terminals['worktree-1'] ?? []
      expect(remaining.some(t => t.id === 'terminal-1')).toBe(false)
      expect(remaining.some(t => t.id === 'terminal-2')).toBe(true)
    })
  })

  it('does not close on right-click (button 2)', () => {
    renderTabBar()

    // button 2 returns synchronously before any async work, so the assertion
    // can run immediately after dispatching the event.
    fireEvent(
      getTab('Terminal 1'),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 })
    )

    expect(invoke).not.toHaveBeenCalledWith('stop_terminal', {
      terminalId: 'terminal-1',
    })
    const remaining = useTerminalStore.getState().terminals['worktree-1'] ?? []
    expect(remaining.some(t => t.id === 'terminal-1')).toBe(true)
  })
})
