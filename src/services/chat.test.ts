import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/environment', () => ({
  hasBackend: () => true,
}))

vi.mock('@/lib/terminal-instances', () => ({
  disposeTerminal: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { prefetchSessions, reconnectNativeCliSession } from './chat'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useTerminalStore } from '@/store/terminal-store'
import { toast } from 'sonner'
import type { Session } from '@/types/chat'

const toastMock = toast as unknown as {
  success: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

describe('prefetchSessions', () => {
  beforeEach(() => {
    useChatStore.setState({
      sessionWorktreeMap: {},
      worktreePaths: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      executionModes: {},
      sessionLabels: {},
      reviewResults: {},
      answeredQuestions: {},
      submittedAnswers: {},
      fixedReviewFindings: {},
    })
  })

  it('hydrates answered question state and submitted answers from prefetched sessions', async () => {
    const { invoke } = await import('@/lib/transport')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      worktree_id: 'wt-1',
      sessions: [
        {
          id: 'session-1',
          name: 'Session 1',
          order: 0,
          created_at: 1,
          updated_at: 1,
          messages: [],
          version: 2,
          answered_questions: ['tool-1'],
          submitted_answers: {
            'tool-1': [{ questionIndex: 0, selectedOptions: [1] }],
          },
          fixed_findings: [],
          waiting_for_input: false,
        },
      ],
      active_session_id: 'session-1',
      version: 2,
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })

    await prefetchSessions(queryClient, 'wt-1', '/tmp/wt-1')

    const state = useChatStore.getState()
    expect(state.sessionWorktreeMap['session-1']).toBe('wt-1')
    expect(state.answeredQuestions['session-1']?.has('tool-1')).toBe(true)
    expect(state.submittedAnswers['session-1']).toEqual({
      'tool-1': [{ questionIndex: 0, selectedOptions: [1] }],
    })
  })
})

describe('reconnectNativeCliSession', () => {
  const terminalSession: Session = {
    id: 'session-1',
    name: 'Claude',
    order: 0,
    created_at: 1,
    updated_at: 1,
    messages: [],
    version: 2,
    backend: 'claude',
    claude_session_id: 'abc123',
    primary_surface: 'terminal',
    terminal_command: '/usr/local/bin/claude',
    terminal_label: 'Claude',
  } as Session

  beforeEach(async () => {
    toastMock.success.mockClear()
    toastMock.error.mockClear()
    const { invoke } = await import('@/lib/transport')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    useUIStore.setState({ sessionPrimarySurface: {}, sessionTerminalIds: {} })
    useTerminalStore.setState({ terminals: {}, modalTerminalOpen: {} })
    // reconnectNativeCliSession calls setActiveSession; isolate the chat-store
    // from the neighbouring describe block.
    useChatStore.setState({ activeSessionIds: {}, sessionWorktreeMap: {} })
  })

  it('relaunches the terminal and restores the terminal surface', async () => {
    await reconnectNativeCliSession(terminalSession, 'wt-1')

    const ui = useUIStore.getState()
    expect(ui.sessionPrimarySurface['session-1']).toBe('terminal')
    const terminalId = ui.sessionTerminalIds['session-1']
    expect(terminalId).toBeDefined()

    const terminal = useTerminalStore
      .getState()
      .terminals['wt-1']?.find(t => t.id === terminalId)
    // Resumes the same Claude conversation via --resume <id>.
    expect(terminal?.command).toBe('/usr/local/bin/claude')
    expect(terminal?.commandArgs).toEqual(['--resume', 'abc123'])
  })

  it('opens the modal drawer and toasts by default (manual reconnect)', async () => {
    await reconnectNativeCliSession(terminalSession, 'wt-1')

    expect(useTerminalStore.getState().modalTerminalOpen['wt-1']).toBe(true)
    expect(toastMock.success).toHaveBeenCalledTimes(1)
  })

  it('stays silent and inline when openModal/showToast are false (startup auto-restore)', async () => {
    await reconnectNativeCliSession(terminalSession, 'wt-1', {
      openModal: false,
      showToast: false,
    })

    // Terminal still restored...
    expect(useUIStore.getState().sessionTerminalIds['session-1']).toBeDefined()
    // ...but no floating drawer pops and no toast fires.
    expect(useTerminalStore.getState().modalTerminalOpen['wt-1']).toBeUndefined()
    expect(toastMock.success).not.toHaveBeenCalled()
  })
})
