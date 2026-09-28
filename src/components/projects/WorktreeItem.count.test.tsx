import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import type { Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { WorktreeItem } from './WorktreeItem'

const mocks = vi.hoisted(() => ({
  sessions: [] as { id: string; messages: []; archived_at?: number }[],
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/useRemotePicker', () => ({
  useRemotePicker: () => vi.fn(),
  pushNeedsRemotePicker: () => false,
}))
vi.mock('@/components/layout/SidebarWidthContext', () => ({
  useSidebarWidth: () => 280,
}))
vi.mock('@/hooks/useWorktreeTerminalStatus', () => ({
  TerminalStatusIndicator: () => null,
}))
vi.mock('@/services/git-status', () => ({
  useGitStatus: () => ({ data: null }),
}))
vi.mock('@/services/chat', () => ({
  useSessions: () => ({ data: { sessions: mocks.sessions } }),
}))
vi.mock('@/services/projects', () => ({
  useRenameWorktree: () => ({ mutate: vi.fn() }),
  useProjects: () => ({ data: [] }),
}))
vi.mock('@/components/chat/hooks/useCanvasStoreState', () => ({
  useCanvasStoreState: () => ({}),
}))
vi.mock('@/components/chat/session-card-utils', () => ({
  computeSessionCardData: () => ({}),
  groupCardsByStatus: () => [],
  statusConfig: {},
}))
vi.mock('@/components/chat/hooks/useSessionArchive', () => ({
  useSessionArchive: () => ({ handleDeleteSession: vi.fn() }),
}))
vi.mock('./useWorktreeMenuActions', () => ({
  useWorktreeMenuActions: () => ({
    handleArchiveOrClose: vi.fn(),
    preferences: {},
  }),
}))
vi.mock('./WorktreeContextMenu', () => ({
  WorktreeContextMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('@/components/chat/CloseWorktreeDialog', () => ({
  CloseWorktreeDialog: () => null,
}))
vi.mock('@/services/jenkins', () => ({
  useJenkinsStatusCached: () => ({
    data: {
      worktreeId: 'wt-1',
      prId: '42',
      pipeline: null,
      stages: [],
      integrationAttempts: [],
      preview: null,
      previewUrl: 'https://42.preview.example.com',
      previewFreshness: {
        status: 'DOWN',
        previewSha: null,
        shaSource: null,
        prHeadSha: null,
        behindBy: null,
      },
      queue: null,
      overallStatus: 'SUCCESS',
      verdictSource: 'github',
      checkedAt: 0,
    },
  }),
}))
vi.mock('@/services/clickup', () => ({
  useResolvedClickUpTaskId: () => ({ data: 'task-1' }),
  useClickUpTask: () => ({
    data: {
      id: 'task-1',
      name: 'Feature task',
      status: { status: 'IN PROGRESS' },
      assignees: [],
      url: 'https://app.clickup.com/t/task-1',
    },
  }),
}))

const worktree: Worktree = {
  id: 'wt-1',
  project_id: 'project-1',
  name: 'feature',
  path: '/tmp/feature',
  branch: 'feature',
  created_at: 0,
  order: 0,
}

describe('WorktreeItem count', () => {
  beforeEach(() => {
    mocks.sessions = []
    useProjectsStore.setState({ expandedWorktreeIds: new Set() })
  })

  it('shows the session count only while collapsed', async () => {
    mocks.sessions = [
      { id: 's1', messages: [] },
      { id: 's2', messages: [] },
    ]
    const user = userEvent.setup()
    render(
      <WorktreeItem
        worktree={worktree}
        projectId="project-1"
        projectPath="/tmp/project"
        defaultBranch="main"
      />
    )

    expect(
      screen.getByRole('status', { name: '2 sessions' })
    ).toHaveTextContent('2')
    await user.click(screen.getByRole('button', { name: 'Expand sessions' }))
    expect(
      screen.queryByRole('status', { name: '2 sessions' })
    ).not.toBeInTheDocument()
  })

  it('does not show an empty count', () => {
    render(
      <WorktreeItem
        worktree={worktree}
        projectId="project-1"
        projectPath="/tmp/project"
        defaultBranch="main"
      />
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('WorktreeItem status placement', () => {
  it('shows the CI verdict and preview state on a PR worktree', () => {
    render(
      <WorktreeItem
        worktree={{ ...worktree, pr_number: 42 }}
        projectId="project-1"
        projectPath="/tmp/project"
        defaultBranch="main"
      />
    )

    expect(screen.getByRole('button', { name: 'CI OK' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Preview hors ligne' })
    ).toBeInTheDocument()
    const worktreeRow = screen.getByText('feature').closest('[role="button"]')
    expect(worktreeRow).not.toBeNull()
    expect(
      within(worktreeRow as HTMLElement).queryByRole('button', {
        name: 'CI OK',
      })
    ).not.toBeInTheDocument()
  })
})
