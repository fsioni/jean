/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, screen, waitFor } from '@testing-library/react'
import { MainWindowContent } from './MainWindowContent'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: [] }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    installedBackends: ['claude'],
    isLoading: false,
  }),
}))

vi.mock('@/lib/idle', () => ({
  scheduleIdleWork: (fn: () => void) => {
    fn()
    return () => {}
  },
}))

vi.mock('@/components/chat/ChatWindow', () => ({
  ChatWindow: () => <div data-testid="chat-window">Chat</div>,
}))

vi.mock('@/components/dashboard/ProjectCanvasView', () => ({
  ProjectCanvasView: () => (
    <div data-testid="project-canvas">Project canvas</div>
  ),
}))

vi.mock('./LeftSideBar', () => ({
  LeftSideBar: () => <div data-testid="left-sidebar-content">Worktrees</div>,
}))

function fireTouch(
  el: Element,
  type: 'touchstart' | 'touchmove' | 'touchend',
  clientX: number,
  clientY = 100
) {
  const touch = {
    clientX,
    clientY,
    identifier: 0,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
    target: el,
  } as unknown as Touch

  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === 'touchend' ? [] : [touch],
    targetTouches: type === 'touchend' ? [] : [touch],
    changedTouches: [touch],
  })
  el.dispatchEvent(event)
}

describe('MainWindowContent mobile swipe open sidebar', () => {
  beforeEach(() => {
    useUIStore.setState({
      leftSidebarVisible: false,
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    })
    useChatStore.setState({
      activeWorktreePath: null,
      activeWorktreeId: null,
    })
    useProjectsStore.setState({ selectedProjectId: 'proj-1' })
  })

  it('opens the left sidebar when edge-swiping right on project canvas', async () => {
    render(<MainWindowContent />)

    const target = await screen.findByTestId('mobile-swipe-open-sidebar')
    Object.defineProperty(target, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    expect(useUIStore.getState().leftSidebarVisible).toBe(false)

    act(() => {
      fireTouch(target, 'touchstart', 8)
      fireTouch(target, 'touchmove', 200)
      fireTouch(target, 'touchend', 200)
    })

    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('tracks the finger while swiping the left sidebar open', async () => {
    render(<MainWindowContent />)

    const target = await screen.findByTestId('mobile-swipe-open-sidebar')
    Object.defineProperty(target, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    expect(
      screen.getByTestId('mobile-swipe-sidebar-underlay')
    ).toContainElement(await screen.findByTestId('left-sidebar-content'))

    act(() => {
      fireTouch(target, 'touchstart', 8)
      fireTouch(target, 'touchmove', 120)
    })

    expect(target).toHaveStyle({ transform: 'translateX(112px)' })
    expect(screen.getByTestId('mobile-swipe-sidebar-underlay')).toBeVisible()
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
  })

  it('does not open sidebar when already visible', async () => {
    useUIStore.setState({ leftSidebarVisible: true })
    render(<MainWindowContent />)

    const target = await screen.findByTestId('mobile-swipe-open-sidebar')
    Object.defineProperty(target, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    act(() => {
      fireTouch(target, 'touchstart', 8)
      fireTouch(target, 'touchmove', 200)
      fireTouch(target, 'touchend', 200)
    })

    // Still true (gesture disabled while open — no toggle)
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('uses swipe-back on chat instead of open-sidebar target', async () => {
    useChatStore.setState({
      activeWorktreePath: '/tmp/wt',
      activeWorktreeId: 'wt-1',
    })

    render(<MainWindowContent />)

    await waitFor(() => {
      expect(screen.getByTestId('chat-window')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('mobile-swipe-open-sidebar')).toBeNull()
  })

  it('does not open sidebar while SessionChatModal is open (opened worktree)', async () => {
    useUIStore.setState({
      leftSidebarVisible: false,
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'wt-1',
    })

    render(<MainWindowContent />)

    const target = await screen.findByTestId('mobile-swipe-open-sidebar')
    Object.defineProperty(target, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    act(() => {
      fireTouch(target, 'touchstart', 8)
      fireTouch(target, 'touchmove', 200)
      fireTouch(target, 'touchend', 200)
    })

    // Modal owns the edge swipe (close); open-sidebar must stay off
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
  })
})

describe('MainWindowContent mobile swipe terminal', () => {
  beforeEach(() => {
    useUIStore.setState({
      leftSidebarVisible: false,
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    })
    useChatStore.setState({
      activeWorktreePath: '/tmp/wt',
      activeWorktreeId: 'wt-1',
    })
    useProjectsStore.setState({ selectedProjectId: 'proj-1' })
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

  it('opens the terminal panel on right-edge swipe left', async () => {
    render(<MainWindowContent />)

    const target = await screen.findByTestId('mobile-swipe-open-terminal')
    Object.defineProperty(target, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    expect(useTerminalStore.getState().terminalVisible).toBe(false)

    act(() => {
      fireTouch(target, 'touchstart', 392)
      fireTouch(target, 'touchmove', 180)
      fireTouch(target, 'touchend', 180)
    })

    expect(useTerminalStore.getState().terminalPanelOpen['wt-1']).toBe(true)
    expect(useTerminalStore.getState().terminalVisible).toBe(true)
  })

  it('tracks the finger while swiping the terminal open', async () => {
    render(<MainWindowContent />)

    const target = await screen.findByTestId('mobile-swipe-open-terminal')
    Object.defineProperty(target, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    act(() => {
      fireTouch(target, 'touchstart', 392)
      fireTouch(target, 'touchmove', 280)
    })

    expect(target).toHaveStyle({ transform: 'translateX(-112px)' })
    expect(useTerminalStore.getState().terminalVisible).toBe(false)
  })

  it('closes the terminal on left-edge swipe right when open', async () => {
    useTerminalStore.setState({
      terminalVisible: true,
      terminalPanelOpen: { 'wt-1': true },
      terminals: {
        'wt-1': [
          {
            id: 't1',
            worktreeId: 'wt-1',
            command: null,
            label: 'Terminal',
            kind: 'panel',
          },
        ],
      },
    })

    render(<MainWindowContent />)

    const target = await screen.findByTestId('mobile-swipe-chat')
    Object.defineProperty(target, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    act(() => {
      fireTouch(target, 'touchstart', 8)
      fireTouch(target, 'touchmove', 200)
      fireTouch(target, 'touchend', 200)
    })

    // animateToEnd is false while terminal is open → closes immediately
    expect(useTerminalStore.getState().terminalVisible).toBe(false)
    expect(useTerminalStore.getState().terminalPanelOpen['wt-1']).toBe(false)
    // Should not leave chat
    expect(useChatStore.getState().activeWorktreePath).toBe('/tmp/wt')
  })

  it('does not open terminal when already visible', async () => {
    useTerminalStore.setState({
      terminalVisible: true,
      terminalPanelOpen: { 'wt-1': true },
      terminals: {
        'wt-1': [
          {
            id: 't1',
            worktreeId: 'wt-1',
            command: null,
            label: 'Terminal',
            kind: 'panel',
          },
        ],
      },
    })

    render(<MainWindowContent />)

    const target = await screen.findByTestId('mobile-swipe-open-terminal')
    Object.defineProperty(target, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    const before = useTerminalStore.getState().terminals['wt-1']?.length

    act(() => {
      fireTouch(target, 'touchstart', 392)
      fireTouch(target, 'touchmove', 180)
      fireTouch(target, 'touchend', 180)
    })

    // Gesture disabled while open — no extra terminal
    expect(useTerminalStore.getState().terminals['wt-1']?.length).toBe(before)
    expect(useTerminalStore.getState().terminalVisible).toBe(true)
  })
})
