import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { MagicModal } from './MagicModal'

const mocks = vi.hoisted(() => {
  const worktree = {
    id: 'wt-1',
    project_id: 'project-1',
    name: 'feature',
    path: '/repo/worktree',
    branch: 'feature-branch',
    pr_number: null as number | null,
    pr_url: null as string | null,
  }
  return {
    setMagicModalOpen: vi.fn(),
    selectWorktree: vi.fn(),
    invokeMock: vi.fn(),
    invalidateQueries: vi.fn(),
    triggerImmediateGitPoll: vi.fn(),
    fetchWorktreesStatus: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    openExternal: vi.fn(),
    worktree,
  }
})

interface UiState {
  magicModalOpen: boolean
  setMagicModalOpen: typeof mocks.setMagicModalOpen
  sessionChatModalWorktreeId: string | null
  sessionChatModalOpen: boolean
  setUpdatePrModalOpen: ReturnType<typeof vi.fn>
  setReviewCommentsModalOpen: ReturnType<typeof vi.fn>
  setReleaseNotesModalOpen: ReturnType<typeof vi.fn>
  setLinkedProjectsModalOpen: ReturnType<typeof vi.fn>
}

interface ProjectsState {
  selectedWorktreeId: string
  selectedProjectId: string
}

interface ChatState {
  activeWorktreeId: string | null
  activeWorktreePath: string | null
  activeSessionIds: Record<string, string>
}

vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(
    (selector?: (state: UiState) => unknown) => {
      const state: UiState = {
        magicModalOpen: true,
        setMagicModalOpen: mocks.setMagicModalOpen,
        sessionChatModalWorktreeId: null,
        sessionChatModalOpen: false,
        setUpdatePrModalOpen: vi.fn(),
        setReviewCommentsModalOpen: vi.fn(),
        setReleaseNotesModalOpen: vi.fn(),
        setLinkedProjectsModalOpen: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        setUpdatePrModalOpen: vi.fn(),
        setReviewCommentsModalOpen: vi.fn(),
        setReleaseNotesModalOpen: vi.fn(),
        setLinkedProjectsModalOpen: vi.fn(),
      }),
    }
  ),
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: Object.assign(
    (selector?: (state: ProjectsState) => unknown) => {
      const state: ProjectsState = {
        selectedWorktreeId: 'wt-1',
        selectedProjectId: 'project-1',
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({ selectWorktree: mocks.selectWorktree }) }
  ),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: Object.assign(
    (selector?: (state: ChatState) => unknown) => {
      const state: ChatState = {
        activeWorktreeId: null,
        activeWorktreePath: null,
        activeSessionIds: {},
      }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        activeWorktreePath: null,
        setWorktreeLoading: vi.fn(),
        clearWorktreeLoading: vi.fn(),
        setActiveWorktree: vi.fn(),
        setPendingMagicCommand: vi.fn(),
      }),
    }
  ),
}))

vi.mock('@/services/projects', () => ({
  useWorktree: () => ({ data: mocks.worktree }),
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        name: 'Project',
        path: '/repo',
        default_branch: 'main',
      },
    ],
  }),
  saveWorktreePr: vi.fn(),
  linkWorktreePr: (
    worktreeId: string,
    worktreePath: string,
    prNumber: number
  ) =>
    mocks.invokeMock('link_worktree_pr', {
      worktreeId,
      worktreePath,
      prNumber,
    }),
  projectsQueryKeys: {
    worktrees: (projectId: string) => ['projects', projectId, 'worktrees'],
    all: ['projects'],
  },
}))

vi.mock('@/services/github', () => ({
  useLoadedIssueContexts: () => ({ data: [] }),
  useLoadedPRContexts: () => ({ data: [] }),
  useLoadedAdvisoryContexts: () => ({ data: [] }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: { default_backend: 'claude' } }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: [] }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: ['claude'] }),
}))

vi.mock('@/hooks/useRemotePicker', () => ({
  useRemotePicker: () => vi.fn(),
}))

vi.mock('@/services/git-status', () => ({
  triggerImmediateGitPoll: mocks.triggerImmediateGitPoll,
  fetchWorktreesStatus: mocks.fetchWorktreesStatus,
  gitPush: vi.fn(),
  performGitPull: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invokeMock }))
vi.mock('@/lib/platform', () => ({
  openExternal: mocks.openExternal,
  isMacOS: false,
  isWindows: false,
  isLinux: true,
}))
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal()),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}))
vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    loading: vi.fn(() => 'toast-1'),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('@/components/chat/ReviewMethodModal', () => ({
  ReviewMethodModal: () => null,
}))

describe('MagicModal manual PR link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.worktree.pr_number = null
    mocks.worktree.pr_url = null
    mocks.invokeMock.mockResolvedValue({
      pr_number: 123,
      pr_url: 'https://github.com/o/r/pull/123',
      title: 'Fix bug',
    })
  })

  it('opens a Link PR dialog and links the selected PR number', async () => {
    const user = userEvent.setup()
    render(<MagicModal />)

    await user.click(screen.getByRole('button', { name: /link pr/i }))
    await user.type(screen.getByLabelText(/pr number/i), '123')
    await user.click(screen.getByRole('button', { name: /^link pr$/i }))

    await waitFor(() => {
      expect(mocks.invokeMock).toHaveBeenCalledWith('link_worktree_pr', {
        worktreeId: 'wt-1',
        worktreePath: '/repo/worktree',
        prNumber: 123,
      })
    })
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['projects', 'project-1', 'worktrees'],
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Linked PR #123: Fix bug',
      expect.any(Object)
    )
  })
})
