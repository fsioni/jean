import { act, renderHook } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useMessageSending } from './useMessageSending'
import type { ExecutionMode } from '@/types/chat'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
  },
}))

vi.mock('@/services/chat', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/chat')>()
  return {
    ...actual,
    cancelChatMessage: vi.fn(),
    persistEnqueue: vi.fn(),
  }
})

function renderUseMessageSending({
  goalMode,
}: {
  goalMode?: 'build' | 'yolo'
} = {}) {
  const sendMessage = { mutate: vi.fn() }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const inputRef = {
    current: { value: '/goal Ship the feature' } as HTMLTextAreaElement,
  }
  const executionModeRef = { current: 'plan' as ExecutionMode }

  const hook = renderHook(() =>
    useMessageSending({
      activeSessionId: 'session-1',
      activeWorktreeId: 'worktree-1',
      activeWorktreePath: '/tmp/worktree',
      inputRef,
      selectedModelRef: { current: 'gpt-5.5' },
      selectedProviderRef: { current: null },
      selectedThinkingLevelRef: { current: 'off' },
      selectedEffortLevelRef: { current: 'high' },
      executionModeRef,
      useAdaptiveThinkingRef: { current: false },
      isCodexBackendRef: { current: true },
      mcpServersDataRef: { current: [] },
      enabledMcpServersRef: { current: [] },
      selectedBackendRef: { current: 'codex' },
      preferences: {
        codex_goal_execution_mode: goalMode,
      },
      sendMessage,
      queryClient,
      markAtBottom: vi.fn(),
      sessionsData: { sessions: [{ id: 'session-1' }] },
      setInputDraft: vi.fn(),
      clearInputDraft: vi.fn(),
      clearChatInputState: vi.fn(),
    })
  )

  return { ...hook, sendMessage, executionModeRef }
}

describe('useMessageSending Codex /goal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    useChatStore.setState({
      inputDrafts: {},
      pendingImages: {},
      pendingFiles: {},
      pendingTextFiles: {},
      pendingSkills: {},
      sendingSessionIds: {},
      executionModes: {},
      selectedModels: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
      reviewingSessions: {},
      waitingForInputSessionIds: {},
      messageQueues: {},
      approvedTools: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
    })
  })

  it('starts goals in build mode by default', async () => {
    const { result, sendMessage, executionModeRef } = renderUseMessageSending()

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(mockInvoke).toHaveBeenCalledWith('codex_goal_set', {
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree',
      sessionId: 'session-1',
      objective: 'Ship the feature',
    })
    expect(useChatStore.getState().executionModes['session-1']).toBe('build')
    expect(executionModeRef.current).toBe('build')
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'build',
        message: 'Work toward the active goal:\n\nShip the feature',
        backend: 'codex',
      }),
      expect.any(Object)
    )
  })

  it('starts goals in yolo mode when configured', async () => {
    const { result, sendMessage, executionModeRef } = renderUseMessageSending({
      goalMode: 'yolo',
    })

    await act(async () => {
      await result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    expect(useChatStore.getState().executionModes['session-1']).toBe('yolo')
    expect(executionModeRef.current).toBe('yolo')
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: 'yolo',
        message: 'Work toward the active goal:\n\nShip the feature',
      }),
      expect.any(Object)
    )
  })
})
