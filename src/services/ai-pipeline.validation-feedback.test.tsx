import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import {
  useResumeAiPipelineTask,
  useStartAiPipelineValidation,
} from './ai-pipeline'
import type { ValidationExecution } from '@/types/ai-pipeline'

vi.mock('@/lib/transport', () => ({ invoke: vi.fn() }))
vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn((message: string) =>
      message.startsWith('Reprise') ? 'resume-toast' : 'validation-toast'
    ),
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

function setup() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  return renderHook(
    () => useStartAiPipelineValidation('p1', { notify: true }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(invoke).mockReset()
})

describe('validation launch feedback', () => {
  it.each([
    [
      'blocked',
      'Validation bloquée : jean.json contient des modifications locales.',
      'warning',
    ],
    [
      'waiting',
      'Validation en attente. Consulte son suivi sur le worktree.',
      'warning',
    ],
    [
      'pending',
      'Validation en attente. Consulte son suivi sur le worktree.',
      'warning',
    ],
    [
      'running',
      'Validation démarrée. Consulte son suivi sur le worktree.',
      'success',
    ],
    [
      'failed',
      'Validation échouée : consulte son suivi sur le worktree.',
      'error',
    ],
    [
      'ready',
      'Validation prête. Consulte son suivi sur le worktree.',
      'success',
    ],
  ] as const)(
    'reports %s instead of an unconditional success',
    async (status, message, level) => {
      vi.mocked(invoke).mockResolvedValue({
        status,
        blocker:
          status === 'blocked'
            ? 'jean.json contient des modifications locales.'
            : null,
      } as ValidationExecution)
      const { result } = setup()
      act(() => result.current.mutate({ worktreeId: 'w1' }))
      await waitFor(() =>
        expect(toast[level]).toHaveBeenCalledWith(message, {
          id: 'validation-toast',
        })
      )
      if (status !== 'ready' && status !== 'running')
        expect(toast.success).not.toHaveBeenCalled()
    }
  )

  it('replaces the loading toast even after the caller unmounts', async () => {
    let complete!: (value: ValidationExecution) => void
    vi.mocked(invoke).mockReturnValue(
      new Promise(resolve => {
        complete = resolve
      })
    )
    const { result, unmount } = setup()
    act(() => result.current.mutate({ worktreeId: 'w1' }))
    await waitFor(() => expect(toast.loading).toHaveBeenCalled())
    unmount()
    await act(async () =>
      complete({
        status: 'blocked',
        blocker: 'Dirty worktree',
      } as ValidationExecution)
    )
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Validation bloquée : Dirty worktree',
        { id: 'validation-toast' }
      )
    )
  })

  it('replaces the loading toast on command failure', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Unavailable'))
    const { result } = setup()
    act(() => result.current.mutate({ worktreeId: 'w1' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Worktree conservé ; validation non lancée : Error: Unavailable',
        { id: 'validation-toast' }
      )
    )
  })
})

describe('durable recovery and validation chain', () => {
  function setupResume() {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    return renderHook(() => useResumeAiPipelineTask('p1'), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
  }
  const resumed = {
    worktree: { id: 'w1' },
    github: { ok: true, message: 'GitHub repris' },
    clickup: { ok: true, message: 'ClickUp repris' },
  }

  it('launches validation when recovery finishes after the list unmounts', async () => {
    let complete!: (value: unknown) => void
    vi.mocked(invoke).mockImplementation(command =>
      command === 'resume_ai_pipeline_task'
        ? new Promise(resolve => {
            complete = resolve
          })
        : Promise.resolve({ status: 'blocked', blocker: 'Dirty worktree' })
    )
    const { result, unmount } = setupResume()
    act(() =>
      result.current.mutate({ taskId: 't1', prNumber: 12, validate: true })
    )
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'resume_ai_pipeline_task',
        expect.anything()
      )
    )
    unmount()
    await act(async () => complete(resumed))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('start_ai_pipeline_validation', {
        projectId: 'p1',
        worktreeId: 'w1',
        taskId: 't1',
        prNumber: 12,
      })
    )
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Validation bloquée : Dirty worktree',
        { id: 'validation-toast' }
      )
    )
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'PR #12 reprise — ✓ GitHub repris  ·  ✓ ClickUp repris',
        { id: 'resume-toast' }
      )
    )
  })

  it('preserves successful recovery when validation fails', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(resumed)
      .mockRejectedValueOnce(new Error('Unavailable'))
    const { result } = setupResume()
    await act(async () => {
      await expect(
        result.current.mutateAsync({ taskId: 't1', validate: true })
      ).resolves.toEqual(resumed)
    })
    expect(toast.error).toHaveBeenCalledWith(
      'Worktree conservé ; validation non lancée : Error: Unavailable',
      { id: 'validation-toast' }
    )
  })

  it('does not validate a partial claim and reports it durably', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...resumed, clickup: { ok: false } })
    const { result } = setupResume()
    await act(async () => {
      await result.current.mutateAsync({ taskId: 't1', validate: true })
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith(
      'Worktree conservé. Validation non lancée : prise en charge incomplète.'
    )
  })
})

describe('durable recovery failure feedback', () => {
  it('replaces the recovery loading toast after unmount and command failure', async () => {
    let fail!: (error: Error) => void
    vi.mocked(invoke).mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject
      })
    )
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const { result, unmount } = renderHook(
      () => useResumeAiPipelineTask('p1'),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      }
    )
    act(() => result.current.mutate({ taskId: 't1' }))
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    unmount()
    await act(async () => fail(new Error('Unavailable')))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Échec de la reprise (ticket t1) : Error: Unavailable',
        { id: 'resume-toast' }
      )
    )
  })
})
