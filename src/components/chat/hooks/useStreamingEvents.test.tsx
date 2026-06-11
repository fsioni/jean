import { createElement, type PropsWithChildren } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useStreamingEvents from './useStreamingEvents'
import { useChatStore } from '@/store/chat-store'

const { mockInvoke, mockListen, mockSaveWorktreePr, registeredListeners } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn().mockResolvedValue(undefined),
    mockListen: vi.fn(),
    mockSaveWorktreePr: vi.fn(),
    registeredListeners: new Map<
      string,
      (event: { payload: unknown }) => void
    >(),
  }))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
  listen: mockListen,
  useWsConnectionStatus: () => true,
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  saveWorktreePr: mockSaveWorktreePr,
  projectsQueryKeys: {
    all: ['projects'],
    list: () => ['projects'],
  },
}))

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function setupListenMock() {
  vi.clearAllMocks()
  registeredListeners.clear()
  mockInvoke.mockImplementation((command: string) =>
    command === 'list_pending_wakeups'
      ? Promise.resolve([])
      : Promise.resolve(undefined)
  )

  mockListen.mockImplementation(
    (eventName: string, callback: (event: { payload: unknown }) => void) => {
      registeredListeners.set(eventName, callback)
      return Promise.resolve(() => {
        registeredListeners.delete(eventName)
      })
    }
  )
}

describe('useStreamingEvents Codex MCP elicitation', () => {
  beforeEach(() => {
    setupListenMock()

    useChatStore.setState({
      enabledMcpServers: {},
      pendingCodexMcpElicitationRequests: {},
      waitingForInputSessionIds: {},
      worktreePaths: {},
    })
  })

  it('auto-accepts Codex MCP elicitation when server is enabled for the session', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    useChatStore.setState({
      enabledMcpServers: {
        'session-1': ['notion'],
      },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_mcp_elicitation_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_mcp_elicitation_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 42,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      },
    })

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('respond_codex_mcp_elicitation', {
        sessionId: 'session-1',
        rpcId: 42,
        action: 'accept',
      })
    )

    expect(
      useChatStore.getState().pendingCodexMcpElicitationRequests['session-1'] ??
        []
    ).toEqual([])
    expect(useChatStore.getState().waitingForInputSessionIds['session-1']).toBe(
      undefined
    )
  })

  it('queues Codex MCP elicitation when server is not enabled for the session', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(
        registeredListeners.has('chat:codex_mcp_elicitation_request')
      ).toBe(true)
    )

    registeredListeners.get('chat:codex_mcp_elicitation_request')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        request: {
          rpc_id: 99,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      },
    })

    await waitFor(() =>
      expect(
        useChatStore.getState().pendingCodexMcpElicitationRequests['session-1']
      ).toEqual([
        {
          rpc_id: 99,
          server_name: 'notion',
          message: 'Need auth',
          mode: 'url',
          url: 'https://example.com',
        },
      ])
    )

    expect(mockInvoke).not.toHaveBeenCalledWith(
      'respond_codex_mcp_elicitation',
      expect.anything()
    )
    expect(useChatStore.getState().waitingForInputSessionIds['session-1']).toBe(
      true
    )
  })
})

describe('useStreamingEvents cancellation sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredListeners.clear()

    mockListen.mockImplementation(
      (eventName: string, callback: (event: { payload: unknown }) => void) => {
        registeredListeners.set(eventName, callback)
        return Promise.resolve(() => {
          registeredListeners.delete(eventName)
        })
      }
    )

    useChatStore.setState({
      streamingContents: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      activeToolCalls: {},
      sendingSessionIds: {},
      sendStartedAt: {},
      sessionWorktreeMap: {},
      worktreePaths: {},
      messageQueues: {},
      lastSentMessages: {},
      compactingSessions: {},
      cancellingSessionIds: {},
    })
  })

  it('does not persist Claude compact-summary text when cancelling a partial response', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)
    const compactSummary =
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n- old compacted work\n\nContinue the conversation from where it left off without asking the user any further questions.'

    queryClient.setQueryData(['chat', 'session', 'session-1'], {
      id: 'session-1',
      name: 'Test',
      order: 0,
      created_at: 1,
      updated_at: 1,
      messages: [
        {
          id: 'user-1',
          session_id: 'session-1',
          role: 'user',
          content: 'continue',
          timestamp: 1,
          tool_calls: [],
        },
      ],
    })

    useChatStore.setState({
      streamingContents: {
        'session-1': `${compactSummary}Actual partial response.`,
      },
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: compactSummary },
          { type: 'text', text: 'Actual partial response.' },
        ],
      },
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': 1000 },
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      worktreePaths: { 'worktree-1': '/tmp/worktree' },
    })

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:cancelled')).toBe(true)
    )

    registeredListeners.get('chat:cancelled')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        undo_send: false,
        emitted_at_ms: 2000,
      },
    })

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'save_cancelled_message',
        expect.objectContaining({
          content: 'Actual partial response.',
          contentBlocks: [{ type: 'text', text: 'Actual partial response.' }],
        })
      )
    )

    const session = queryClient.getQueryData<{
      messages: Array<{
        role: string
        content: string
        content_blocks?: unknown
      }>
    }>(['chat', 'session', 'session-1'])
    const assistant = session?.messages.find(
      message => message.role === 'assistant'
    )

    expect(assistant?.content).toBe('Actual partial response.')
    expect(assistant?.content_blocks).toEqual([
      { type: 'text', text: 'Actual partial response.' },
    ])
  })
})

describe('useStreamingEvents replay dedupe', () => {
  beforeEach(() => {
    setupListenMock()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      streamingContents: { 'session-1': 'Before tool. After tool.' },
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Before tool. ' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'text', text: 'After tool.' },
        ],
      },
      streamingReplayContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Before tool. ' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'text', text: 'After tool.' },
        ],
      },
      activeToolCalls: {
        'session-1': [{ id: 'tool-1', name: 'Bash', input: {} }],
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops replayed chunk and tool-block events from recovered running snapshots', async () => {
    const queryClient = createQueryClient()
    const wrapper = createWrapper(queryClient)

    renderHook(() => useStreamingEvents({ queryClient }), { wrapper })

    await waitFor(() =>
      expect(registeredListeners.has('chat:chunk')).toBe(true)
    )

    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'Before tool. ',
      },
    })
    registeredListeners.get('chat:tool_block')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        tool_call_id: 'tool-1',
      },
    })
    registeredListeners.get('chat:chunk')?.({
      payload: {
        session_id: 'session-1',
        worktree_id: 'worktree-1',
        content: 'After tool.',
      },
    })

    expect(useChatStore.getState().streamingContents['session-1']).toBe(
      'Before tool. After tool.'
    )
    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'text', text: 'Before tool. ' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
        { type: 'text', text: 'After tool.' },
      ]
    )
    expect(
      useChatStore.getState().streamingReplayContentBlocks['session-1']
    ).toBeUndefined()
  })
})
