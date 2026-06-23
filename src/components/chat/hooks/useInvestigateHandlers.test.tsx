import React, { type RefObject } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { defaultPreferences } from '@/types/preferences'
import type {
  EffortLevel,
  ExecutionMode,
  McpServerInfo,
  Session,
  ThinkingLevel,
} from '@/types/chat'
import { useInvestigateHandlers } from './useInvestigateHandlers'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

const ref = <T,>(current: T): RefObject<T> => ({ current })

function makeSession(id: string): Session {
  return {
    id,
    name: id,
    order: 0,
    created_at: 1,
    updated_at: 1,
    messages: [],
    backend: 'claude',
  }
}

function renderHandlers({
  executionMode = 'yolo',
}: {
  executionMode?: ExecutionMode
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const sendMessage = { mutate: vi.fn() }
  const sessions = [
    makeSession('comment-session-1'),
    makeSession('comment-session-2'),
  ]
  const createSession = {
    mutate: vi.fn(),
    mutateAsync: vi.fn(
      async () => sessions.shift() ?? makeSession('extra-session')
    ),
  }

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const hook = renderHook(
    () =>
      useInvestigateHandlers({
        activeSessionId: 'base-session',
        activeWorktreeId: 'worktree-1',
        activeWorktreePath: '/tmp/worktree',
        inputRef: ref({ focus: vi.fn() } as unknown as HTMLTextAreaElement),
        preferences: {
          ...defaultPreferences,
          magic_prompt_modes: {
            ...defaultPreferences.magic_prompt_modes,
            review_comments_mode: executionMode === 'build' ? 'plan' : executionMode,
          },
        },
        defaultBackend: 'claude',
        selectedModelRef: ref('claude-opus-4-8'),
        selectedThinkingLevelRef: ref('off' as ThinkingLevel),
        selectedEffortLevelRef: ref('high' as EffortLevel),
        executionModeRef: ref(executionMode),
        mcpServersDataRef: ref([] as McpServerInfo[]),
        enabledMcpServersRef: ref([]),
        activeWorktreeIdRef: ref('worktree-1'),
        activeWorktreePathRef: ref('/tmp/worktree'),
        sendMessage,
        setSessionProvider: { mutate: vi.fn() },
        setSessionBackend: { mutate: vi.fn() },
        setSessionModel: { mutate: vi.fn() },
        createSession,
        resolveCustomProfile: () => ({
          model: 'claude-opus-4-8',
          customProfileName: undefined,
        }),
        cliVersion: null,
        worktreeProjectId: 'project-1',
      }),
    { wrapper }
  )

  return { ...hook, sendMessage, createSession }
}

describe('useInvestigateHandlers review comments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      activeSessionIds: { 'worktree-1': 'base-session' },
      executionModes: { 'base-session': 'plan' },
      selectedBackends: {},
      selectedModels: {},
      selectedProviders: {},
      sendingSessionIds: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
    })
  })

  it('keeps the session UI execution mode in sync with separate review comment send mode', async () => {
    const { result, sendMessage } = renderHandlers({ executionMode: 'yolo' })

    await act(async () => {
      await result.current.handleReviewComments(['fix one', 'fix two'])
    })

    expect(sendMessage.mutate).toHaveBeenCalledTimes(2)
    expect(sendMessage.mutate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'comment-session-1',
        executionMode: 'yolo',
      }),
      expect.any(Object)
    )
    expect(sendMessage.mutate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'comment-session-2',
        executionMode: 'yolo',
      }),
      expect.any(Object)
    )
    expect(useChatStore.getState().executionModes['comment-session-1']).toBe(
      'yolo'
    )
    expect(useChatStore.getState().executionModes['comment-session-2']).toBe(
      'yolo'
    )
  })

  it('uses an explicit yolo override even when current session mode is plan', async () => {
    const { result, sendMessage } = renderHandlers({ executionMode: 'plan' })

    await act(async () => {
      await result.current.handleReviewComments(['fix one'], {
        executionMode: 'yolo',
      })
    })

    expect(sendMessage.mutate).toHaveBeenCalledTimes(1)
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'comment-session-1',
        executionMode: 'yolo',
      }),
      expect.any(Object)
    )
    expect(useChatStore.getState().executionModes['comment-session-1']).toBe(
      'yolo'
    )
  })
})
