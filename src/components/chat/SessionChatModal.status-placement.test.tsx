import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import type { ValidationExecution } from '@/types/ai-pipeline'
import type { Project, Worktree } from '@/types/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'
import type { ClickUpTask } from '@/types/clickup'
import type * as Environment from '@/lib/environment'
import { SessionChatModal } from './SessionChatModal'

const mocks = vi.hoisted(() => ({
  validations: [] as ValidationExecution[],
  control: vi.fn(),
  mobile: false,
  native: true,
  ci: undefined as JenkinsWorktreeStatus | undefined,
  task: undefined as ClickUpTask | undefined,
}))

vi.mock('@/services/ai-pipeline', () => ({
  useAiPipelineValidations: () => ({
    data: mocks.validations,
    isLoading: false,
    isError: false,
  }),
  useControlAiPipelineValidation: () => ({
    mutate: mocks.control,
    isPending: false,
  }),
  useStartAiPipelineValidation: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.mobile }))
vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof Environment>()),
  isNativeApp: () => mocks.native,
}))
vi.mock('@/services/chat', () => ({
  useSessions: () => ({ data: undefined }),
  useSession: () => ({ data: undefined }),
  useCreateSession: () => ({ mutate: vi.fn() }),
  useClearSessionHistory: () => ({ mutate: vi.fn() }),
  useRenameSession: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))
vi.mock('@/services/projects', () => ({
  usePackageScripts: () => ({ data: [] }),
  useProjects: () => ({ data: [] }),
}))
vi.mock('@/services/github', () => ({
  useGitHubPRs: () => ({ data: [] }),
}))
vi.mock('@/services/git-status', () => ({
  useGitStatus: () => ({ data: undefined }),
}))
vi.mock('@/hooks/useRemotePicker', () => ({
  useRemotePicker: () => vi.fn(),
}))
vi.mock('./hooks/useSessionArchive', () => ({
  useSessionArchive: () => ({}),
}))
// Keep the title bar and its status components real; omit unrelated panes.
vi.mock('./ChatWindow', () => ({ ChatWindow: () => null }))
vi.mock('./ModalTerminalDrawer', () => ({ ModalTerminalDrawer: () => null }))
vi.mock('@/components/browser/ModalBrowserDrawer', () => ({
  ModalBrowserDrawer: () => null,
}))
vi.mock('@/components/open-in/OpenInButton', () => ({
  OpenInButton: () => null,
}))
vi.mock('@/components/open-in/ScriptsButton', () => ({
  ScriptsButton: () => null,
}))
vi.mock('@/components/projects/WorktreeDropdownMenu', () => ({
  WorktreeDropdownMenu: () => null,
}))
vi.mock('./LabelModal', () => ({ LabelModal: () => null }))
vi.mock('@/services/jenkins', () => ({
  useJenkinsStatusCached: (id: string) => ({
    data: id === 'wt-1' ? mocks.ci : undefined,
  }),
}))
vi.mock('@/services/clickup', () => ({
  useResolvedClickUpTaskId: (id: string) => ({
    data: id === 'wt-1' ? mocks.task?.id : undefined,
  }),
  useClickUpTask: (id: string | null, projectId: string) => ({
    data:
      id === mocks.task?.id && projectId === 'project-1'
        ? mocks.task
        : undefined,
  }),
}))

const project: Project = {
  id: 'project-1',
  name: 'Project',
  path: '/tmp/project',
  default_branch: 'main',
  added_at: 0,
  order: 0,
}
const worktree: Worktree = {
  id: 'wt-1',
  project_id: project.id,
  name: 'Feature',
  path: '/tmp/feature',
  branch: 'feature',
  pr_number: 42,
  created_at: 0,
  order: 0,
}

function renderOpenWorktree(
  currentWorktree = worktree,
  currentProject: Project | null = project
) {
  return render(
    <SessionChatModal
      worktreeId={currentWorktree.id}
      worktreePath={currentWorktree.path}
      worktree={currentWorktree}
      project={currentProject}
      isOpen
      onClose={vi.fn()}
      onRequestCloseWorktree={vi.fn()}
    />
  )
}

beforeEach(() => {
  useUIStore.setState({ zenMode: false })
  mocks.validations = []
  mocks.control.mockClear()
  mocks.mobile = false
  mocks.native = true
  mocks.ci = {
    worktreeId: 'wt-1',
    prId: '42',
    pipeline: null,
    stages: [],
    integrationAttempts: [],
    preview: null,
    previewUrl: null,
    previewFreshness: null,
    queue: null,
    overallStatus: 'SUCCESS',
    verdictSource: 'github',
    checkedAt: 0,
  }
  mocks.task = {
    id: 'task-1',
    name: 'Feature task',
    status: { status: 'IN PROGRESS' },
    assignees: [],
    url: 'https://app.clickup.com/t/task-1',
  }
})

describe('open worktree title-bar status', () => {
  it.each([
    ['native desktop', false, true],
    ['web desktop', false, false],
    ['mobile', true, false],
  ] as const)(
    'shows CI and ClickUp in the title bar on %s',
    (_, mobile, native) => {
      mocks.mobile = mobile
      mocks.native = native
      renderOpenWorktree()

      const titleRow = screen.getByRole('heading', {
        name: /Feature/,
      }).parentElement
      if (!titleRow) throw new Error('Missing worktree title row')
      expect.soft(within(titleRow).queryByText('CI OK')).toBeInTheDocument()
      expect
        .soft(within(titleRow).queryByRole('button', { name: 'IN PROGRESS' }))
        .toBeInTheDocument()
    }
  )

  it.each([
    ['native desktop', false, true],
    ['web desktop', false, false],
    ['mobile', true, false],
  ] as const)(
    'opens the pipeline from the real worktree header on %s',
    (_, mobile, native) => {
      mocks.mobile = mobile
      mocks.native = native
      mocks.validations = [
        {
          schema_version: 1,
          id: 'validation',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          repository_path: '/tmp/wt-1',
          task_id: 'task-1',
          pr_number: 42,
          revision: 1,
          step: 'review',
          status: 'blocked',
          created_at: '',
          updated_at: '',
          head_commit: null,
          deployed_commit: null,
          correction_cycles: 3,
          no_progress_cycles: 0,
          requirements: [],
          evidence: [],
          defects: [],
          transitions: [],
          effects: [],
          limitations: [],
          blocker: 'Revue annulée',
          paused: false,
        },
      ]
      renderOpenWorktree()
      const titleRow = screen.getByRole('heading', {
        name: /Feature/,
      }).parentElement
      if (!titleRow) throw new Error('Missing title row')
      fireEvent.click(
        within(titleRow).getByRole('button', { name: /Suivre la pipeline IA/ })
      )
      expect(screen.getByText('Revue annulée')).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', { name: 'Reprendre la validation' })
      )
      expect(mocks.control).toHaveBeenCalledWith(
        { executionId: 'validation', action: 'resume' },
        expect.anything()
      )
      expect(
        screen.getByRole('heading', { name: /Feature/ })
      ).toBeInTheDocument()
    }
  )

  it('shows status before the optional project snapshot loads', () => {
    renderOpenWorktree(worktree, null)

    const titleRow = screen.getByRole('heading', {
      name: 'Feature',
    }).parentElement
    if (!titleRow) throw new Error('Missing worktree title row')
    expect.soft(within(titleRow).queryByText('CI OK')).toBeInTheDocument()
    expect
      .soft(within(titleRow).queryByRole('button', { name: 'IN PROGRESS' }))
      .toBeInTheDocument()
  })

  it('wraps status below a mobile title and allows desktop badges to wrap without clipping', () => {
    mocks.mobile = true
    renderOpenWorktree()

    const title = screen.getByRole('heading', { name: /Feature/ })
    const titleGroup = title.parentElement
    const header = titleGroup?.parentElement
    expect.soft(title).toHaveClass('basis-full', 'sm:basis-auto')
    expect.soft(titleGroup).toHaveClass('flex-wrap')
    expect.soft(header).toHaveClass('h-auto', 'sm:min-h-11')
    expect.soft(header).toHaveClass('items-start', 'sm:items-center')
  })

  it('does not show CI without a PR or ClickUp without a linked task', () => {
    mocks.task = undefined
    renderOpenWorktree({ ...worktree, pr_number: undefined })

    expect(screen.getByRole('heading', { name: /Feature/ })).toBeInTheDocument()
    expect(screen.queryByText('CI OK')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'IN PROGRESS' })
    ).not.toBeInTheDocument()
  })
})
