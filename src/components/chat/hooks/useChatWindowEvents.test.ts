import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useChatWindowEvents } from './useChatWindowEvents'
import { useUIStore } from '@/store/ui-store'

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/services/chat', () => ({
  cancelChatMessage: vi.fn(),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => false,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
  },
}))

describe('useChatWindowEvents worktree approval shortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
    useUIStore.setState({
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
      newSessionModeTarget: null,
      sessionPrimarySurface: {},
      sessionTerminalIds: {},
    })
  })

  function renderUseChatWindowEvents(
    overrides: Partial<Parameters<typeof useChatWindowEvents>[0]> = {}
  ) {
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    const inputRef = { current: input }
    const scrollViewportRef = { current: null }

    const params: Parameters<typeof useChatWindowEvents>[0] = {
      inputRef,
      activeSessionId: 'session-1',
      activeWorktreeId: 'worktree-1',
      activeWorktreePath: '/tmp/worktree-1',
      isModal: false,
      latestPlanContent: null,
      latestPlanFilePath: null,
      setPlanDialogContent: vi.fn(),
      setIsPlanDialogOpen: vi.fn(),
      session: null,
      gitStatus: null,
      setDiffRequest: vi.fn(),
      isAtBottom: true,
      scrollToBottom: vi.fn(),
      currentStreamingContentBlocks: [],
      isSending: false,
      currentQueuedMessages: [],
      preferences: undefined,
      patchPreferences: {
        mutate: vi.fn(),
      },
      handleSaveContext: vi.fn(),
      handleLoadContext: vi.fn(),
      runScripts: [],
      hasPendingPlanApproval: true,
      pendingPlanMessage: { id: 'msg-1' },
      handlePlanApproval: vi.fn(),
      handlePlanApprovalYolo: vi.fn(),
      handleClearContextApproval: vi.fn(),
      handleClearContextApprovalBuild: vi.fn(),
      handleWorktreeBuildApproval: vi.fn(),
      handleWorktreeYoloApproval: vi.fn(),
      scrollViewportRef,
      beginKeyboardScroll: vi.fn(),
      endKeyboardScroll: vi.fn(),
      ...overrides,
    }

    renderHook(() => useChatWindowEvents(params))
    return params
  }

  it('smooth-scrolls a medium amount for Option+Cmd arrow scroll events', () => {
    const viewport = document.createElement('div')
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      value: 1000,
    })
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 3000,
    })
    viewport.scrollTop = 1000

    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(180)
        return 1
      })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    vi.spyOn(performance, 'now').mockReturnValue(0)

    const beginKeyboardScroll = vi.fn()
    const endKeyboardScroll = vi.fn()
    renderUseChatWindowEvents({
      isAtBottom: false,
      scrollViewportRef: { current: viewport },
      beginKeyboardScroll,
      endKeyboardScroll,
    })

    window.dispatchEvent(
      new CustomEvent('scroll-chat', {
        detail: { direction: 'down', amount: 'medium' },
      })
    )

    expect(beginKeyboardScroll).toHaveBeenCalled()
    expect(viewport.scrollTop).toBe(1350)
    expect(endKeyboardScroll).toHaveBeenCalled()
    expect(requestAnimationFrameSpy).toHaveBeenCalled()
  })

  it('re-focuses chat input after terminal steals focus on worktree open', () => {
    vi.useFakeTimers()

    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const terminalInput = document.createElement('textarea')
    terminal.appendChild(terminalInput)
    document.body.appendChild(terminal)

    const params = renderUseChatWindowEvents()

    window.setTimeout(() => {
      terminalInput.focus()
    }, 10)

    vi.advanceTimersByTime(250)

    expect(document.activeElement).toBe(params.inputRef.current)
  })

  it('opens the new session mode picker for CMD+T events', () => {
    renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('create-new-session'))

    expect(useUIStore.getState().newSessionModeTarget).toEqual({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
      intent: 'picker',
    })
  })

  it('handles worktree build approval for a pending plan', () => {
    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan-worktree-build'))

    expect(params.handleWorktreeBuildApproval).toHaveBeenCalledWith('msg-1')
  })

  it('handles plan approval for a pending plan', () => {
    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan'))

    expect(params.handlePlanApproval).toHaveBeenCalledWith('msg-1')
  })

  it('handles yolo approval for a pending plan', () => {
    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan-yolo'))

    expect(params.handlePlanApprovalYolo).toHaveBeenCalledWith('msg-1')
  })

  it('handles clear-context and worktree approvals for a pending plan', () => {
    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan-clear-context'))
    window.dispatchEvent(new CustomEvent('approve-plan-clear-context-build'))
    window.dispatchEvent(new CustomEvent('approve-plan-worktree-build'))
    window.dispatchEvent(new CustomEvent('approve-plan-worktree-yolo'))

    expect(params.handleClearContextApproval).toHaveBeenCalledWith('msg-1')
    expect(params.handleClearContextApprovalBuild).toHaveBeenCalledWith('msg-1')
    expect(params.handleWorktreeBuildApproval).toHaveBeenCalledWith('msg-1')
    expect(params.handleWorktreeYoloApproval).toHaveBeenCalledWith('msg-1')
  })

  it('ignores worktree yolo approval while plan is still streaming', () => {
    const params = renderUseChatWindowEvents({
      hasPendingPlanApproval: false,
    })

    window.dispatchEvent(new CustomEvent('approve-plan-worktree-yolo'))

    expect(params.handleWorktreeYoloApproval).not.toHaveBeenCalled()
  })

  it('ignores approval shortcuts while plan is still streaming', () => {
    const params = renderUseChatWindowEvents({
      hasPendingPlanApproval: false,
    })

    window.dispatchEvent(new CustomEvent('approve-plan'))

    expect(params.handlePlanApproval).not.toHaveBeenCalled()
    expect(params.handleWorktreeYoloApproval).not.toHaveBeenCalled()
  })

  it('ignores worktree approval shortcuts in non-modal chat when a session modal is open', () => {
    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'worktree-2',
    })

    const params = renderUseChatWindowEvents()

    window.dispatchEvent(new CustomEvent('approve-plan-worktree-build'))
    window.dispatchEvent(new CustomEvent('approve-plan-worktree-yolo'))

    expect(params.handleWorktreeBuildApproval).not.toHaveBeenCalled()
    expect(params.handleWorktreeYoloApproval).not.toHaveBeenCalled()
  })
})
