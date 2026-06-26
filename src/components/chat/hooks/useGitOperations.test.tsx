import React, { type RefObject } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useGitOperations } from './useGitOperations'
import type {
  EffortLevel,
  ExecutionMode,
  McpServerInfo,
  Session,
  ThinkingLevel,
} from '@/types/chat'
import type { Project, Worktree } from '@/types/projects'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastLoading: vi.fn(() => 'toast-1'),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invoke }))
vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    info: mocks.toastInfo,
    warning: mocks.toastWarning,
    error: mocks.toastError,
    success: vi.fn(),
  },
}))
vi.mock('@/services/git-status', () => ({
  gitPush: vi.fn(),
  triggerImmediateGitPoll: vi.fn(),
  triggerImmediateRemotePoll: vi.fn(),
  fetchWorktreesStatus: vi.fn(),
  performGitPull: vi.fn(),
}))
vi.mock('@/lib/platform', () => ({
  openExternal: vi.fn(),
  isMacOS: false,
  isWindows: false,
  isLinux: true,
}))

const ref = <T,>(current: T): RefObject<T> => ({ current })

const worktree: Worktree = {
  id: 'wt-1',
  project_id: 'project-1',
  name: 'feature',
  path: '/repo/worktree',
  branch: 'feature',
  pr_number: 31,
  pr_url: 'https://github.com/o/r/pull/31',
  created_at: 1,
  order: 0,
}

const project: Project = {
  id: 'project-1',
  name: 'Project',
  path: '/repo',
  default_branch: 'main',
  added_at: 1,
  order: 0,
}

function renderGitOperations() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const sendMessage = { mutate: vi.fn() }
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const hook = renderHook(
    () =>
      useGitOperations({
        activeWorktreeId: 'wt-1',
        activeSessionId: 'session-current',
        activeWorktreePath: '/repo/worktree',
        worktree,
        project,
        queryClient,
        inputRef: ref({ focus: vi.fn() } as unknown as HTMLTextAreaElement),
        preferences: {
          default_backend: 'claude',
          selected_model: 'sonnet',
          selected_codex_model: 'gpt-5.5',
          magic_prompts: { resolve_conflicts: 'Resolve and finish.' },
          magic_prompt_backends: { resolve_conflicts_backend: 'codex' },
        } as never,
        setSessionModel: { mutate: vi.fn() },
        setSessionBackend: { mutate: vi.fn() },
        setSessionProvider: { mutate: vi.fn() },
        sendMessage,
        selectedThinkingLevelRef: ref('off' as ThinkingLevel),
        selectedEffortLevelRef: ref('medium' as EffortLevel),
        mcpServersDataRef: ref([] as McpServerInfo[]),
        enabledMcpServersRef: ref([]),
      }),
    { wrapper }
  )

  return { ...hook, sendMessage, queryClient }
}

describe('useGitOperations conflict resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({
      activeSessionIds: { 'wt-1': 'session-current' },
      inputDrafts: {},
      executionModes: { 'session-current': 'plan' as ExecutionMode },
      selectedBackends: {},
      selectedModels: {},
      selectedProviders: {},
      sendingSessionIds: {},
      executingModes: {},
      errors: {},
      lastSentMessages: {},
    })
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_merge_conflicts') {
        return Promise.resolve({
          has_conflicts: true,
          conflicts: ['src/file.ts'],
          conflict_diff: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch',
        })
      }
      if (command === 'create_session') {
        const session: Session = {
          id: 'conflict-session',
          name: 'Resolve conflicts',
          order: 1,
          created_at: 1,
          updated_at: 1,
          messages: [],
          backend: 'claude',
        }
        return Promise.resolve(session)
      }
      return Promise.resolve(undefined)
    })
  })

  it('sends detected conflicts immediately in yolo mode instead of drafting them', async () => {
    const { result, sendMessage } = renderGitOperations()

    await act(async () => {
      await result.current.handleResolveConflicts()
    })

    expect(
      useChatStore.getState().inputDrafts['conflict-session']
    ).toBeUndefined()
    expect(useChatStore.getState().executionModes['conflict-session']).toBe(
      'yolo'
    )
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conflict-session',
        worktreeId: 'wt-1',
        worktreePath: '/repo/worktree',
        model: 'gpt-5.5',
        executionMode: 'yolo',
        effortLevel: 'medium',
        backend: 'codex',
      }),
      expect.any(Object)
    )
    const sentArgs = sendMessage.mutate.mock.calls[0]?.[0]
    expect(sentArgs?.message).toContain(
      'I have merge conflicts that need to be resolved.'
    )
    expect(sentArgs?.message).toContain('Resolve and finish.')
  })

  it('uses the PR conflict flow when no local conflicts exist yet', async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'get_merge_conflicts') {
        return Promise.resolve({
          has_conflicts: false,
          conflicts: [],
          conflict_diff: '',
        })
      }
      if (command === 'fetch_and_merge_base') {
        return Promise.resolve({
          has_conflicts: true,
          conflicts: ['src/pr-file.ts'],
          conflict_diff: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main',
        })
      }
      if (command === 'create_session') {
        const session: Session = {
          id: 'pr-conflict-session',
          name: 'PR: resolve conflicts',
          order: 1,
          created_at: 1,
          updated_at: 1,
          messages: [],
          backend: 'claude',
        }
        return Promise.resolve(session)
      }
      return Promise.resolve(undefined)
    })

    const { result, sendMessage } = renderGitOperations()

    await act(async () => {
      await result.current.handleResolveConflicts()
    })

    expect(mocks.invoke).toHaveBeenCalledWith('fetch_and_merge_base', {
      worktreeId: 'wt-1',
    })
    expect(sendMessage.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'pr-conflict-session',
        executionMode: 'yolo',
        backend: 'codex',
      }),
      expect.any(Object)
    )
    const sentArgs = sendMessage.mutate.mock.calls[0]?.[0]
    expect(sentArgs?.message).toContain(
      'I merged `origin/main` into this branch to resolve PR conflicts'
    )
  })
})
