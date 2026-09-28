import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatQueryKeys } from '@/services/chat'
import { jenkinsQueryKeys } from '@/services/jenkins'
import { useChatStore } from '@/store/chat-store'
import type { Session, WorktreeSessions } from '@/types/chat'
import type { Worktree } from '@/types/projects'
import { WorktreeList } from './WorktreeList'

vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  useReorderWorktrees: () => ({ mutate: vi.fn() }),
}))
vi.mock('./WorktreeItem', () => ({
  WorktreeItem: ({ worktree }: { worktree: Worktree }) => (
    <span>{worktree.name}</span>
  ),
}))
vi.mock('./WorktreeItemSkeleton', () => ({ WorktreeItemSkeleton: () => null }))

const worktree: Worktree = {
  id: 'wt-category',
  project_id: 'project-category',
  name: 'Feature',
  path: '/tmp/feature',
  branch: 'feature',
  created_at: 1,
  order: 0,
  pr_number: 12,
  cached_check_status: 'success',
}
const session: Session = {
  id: 'session-category',
  name: 'Work',
  messages: [],
  order: 0,
  created_at: 1,
  updated_at: 1,
}
let client: QueryClient
function seedSessions(sessions: Session[]) {
  client.setQueryData<WorktreeSessions>(
    [...chatQueryKeys.sessions(worktree.id), 'with-counts'],
    {
      worktree_id: worktree.id,
      sessions,
      active_session_id: session.id,
      version: 2,
    }
  )
}
function show(item = worktree) {
  render(
    <QueryClientProvider client={client}>
      <WorktreeList
        projectId={item.project_id}
        projectPath="/tmp/project"
        defaultBranch="main"
        worktrees={[item]}
        loadSessionCounts={false}
      />
    </QueryClientProvider>
  )
}
function expectCategory(label: string) {
  expect(
    screen.getByRole('button', { name: new RegExp(label) })
  ).toBeInTheDocument()
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useChatStore.setState(useChatStore.getInitialState())
  seedSessions([session])
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.useRealTimers()
})

describe('WorktreeList activity categories', () => {
  it('updates from calm to running to waiting and back without changing worktrees', async () => {
    show()
    expectCategory('Calmes')
    act(() =>
      useChatStore.setState({ sendingSessionIds: { [session.id]: true } })
    )
    await waitFor(() => expectCategory('IA en cours'))
    act(() =>
      useChatStore.setState({
        sendingSessionIds: {},
        waitingForInputSessionIds: { [session.id]: true },
      })
    )
    await waitFor(() => expectCategory('Besoin de ton cerveau'))
    act(() =>
      useChatStore.setState({
        sendingSessionIds: {},
        waitingForInputSessionIds: {},
      })
    )
    await waitFor(() => expectCategory('Calmes'))
  })

  it.each(['plan', 'build', 'yolo'] as const)(
    'groups a live %s run as AI activity',
    mode => {
      useChatStore.setState({
        sendingSessionIds: { [session.id]: true },
        executingModes: { [session.id]: mode },
      })
      show()
      expectCategory('IA en cours')
    }
  )

  it('does not mix session activity between worktrees', () => {
    useChatStore.setState({ sendingSessionIds: { 'another-session': true } })
    show()
    expectCategory('Calmes')
  })

  it('keeps active standby ahead of session activity', () => {
    seedSessions([{ ...session, last_run_status: 'running' }])
    show({
      ...worktree,
      standby_reason: 'Review',
      standby_until: Math.floor(Date.now() / 1000) + 3600,
    })
    expectCategory('Standby métier')
  })

  it.each(['running', 'resumable'] as const)(
    'restores persisted %s activity',
    status => {
      seedSessions([{ ...session, last_run_status: status }])
      show()
      expectCategory('IA en cours')
    }
  )

  it.each([
    { waiting_for_input: true },
    { last_run_status: 'crashed' as const },
    { status_override: 'review' as const },
  ])('shows persisted attention state %j', fields => {
    seedSessions([{ ...session, ...fields }])
    show()
    expectCategory('Besoin de ton cerveau')
  })

  it('reacts to session cache updates and ignores archived sessions', async () => {
    seedSessions([{ ...session, archived_at: 5, last_run_status: 'running' }])
    show()
    expectCategory('Calmes')
    act(() => seedSessions([{ ...session, last_run_status: 'running' }]))
    await waitFor(() => expectCategory('IA en cours'))
  })

  it('uses live CI and preview events instead of stale GitHub success', async () => {
    show()
    expectCategory('Calmes')
    act(() =>
      client.setQueryData(jenkinsQueryKeys.status(worktree.id), {
        overallStatus: 'BUILDING',
        previewFreshness: null,
      })
    )
    await waitFor(() => expectCategory('Jean surveille'))
    act(() =>
      client.setQueryData(jenkinsQueryKeys.status(worktree.id), {
        overallStatus: 'SUCCESS',
        previewFreshness: { status: 'DOWN' },
      })
    )
    await waitFor(() => expectCategory('Besoin de ton cerveau'))
  })

  it('wakes an expired standby without another event', async () => {
    vi.useFakeTimers()
    show({
      ...worktree,
      standby_reason: 'Review',
      standby_until: Math.floor(Date.now() / 1000) + 2,
    })
    expectCategory('Standby métier')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expectCategory('Calmes')
  })
})
