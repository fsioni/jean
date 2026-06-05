import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { OpenInModal } from './OpenInModal'

const mocks = vi.hoisted(() => ({
  setOpenInModalOpen: vi.fn(),
  openPreferencesPane: vi.fn(),
  openRemotePicker: vi.fn(),
  openExternal: vi.fn(),
}))

interface UiStoreMock {
  openInModalOpen: boolean
  setOpenInModalOpen: typeof mocks.setOpenInModalOpen
  openPreferencesPane: typeof mocks.openPreferencesPane
  sessionChatModalWorktreeId: string | null
  openRemotePicker: typeof mocks.openRemotePicker
}

interface ProjectsStoreMock {
  selectedWorktreeId: string
  selectedProjectId: string
}

interface ChatStoreMock {
  activeWorktreeId: string | null
  activeSessionIds: Record<string, string>
}

vi.mock('@/store/ui-store', () => ({
  useUIStore: (selector?: (state: UiStoreMock) => unknown) => {
    const state = {
      openInModalOpen: true,
      setOpenInModalOpen: mocks.setOpenInModalOpen,
      openPreferencesPane: mocks.openPreferencesPane,
      sessionChatModalWorktreeId: null,
      openRemotePicker: mocks.openRemotePicker,
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (selector?: (state: ProjectsStoreMock) => unknown) => {
    const state = {
      selectedWorktreeId: 'wt-1',
      selectedProjectId: 'project-1',
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: Object.assign(
    (selector?: (state: ChatStoreMock) => unknown) => {
      const state = {
        activeWorktreeId: null,
        activeSessionIds: { 'wt-1': 'session-1' },
      }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        getWorktreePath: () => '/repo/worktree',
      }),
    }
  ),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { editor: 'zed', terminal: 'ghostty' },
  }),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => true,
}))

vi.mock('@/lib/platform', () => ({
  openExternal: mocks.openExternal,
  isMacOS: true,
  isWindows: false,
  isLinux: false,
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}))

vi.mock('@/lib/notifications', () => ({
  notify: vi.fn(),
}))

vi.mock('@/services/projects', () => ({
  useWorktree: () => ({
    data: {
      id: 'wt-1',
      path: '/repo/worktree',
      branch: 'fix-advisory',
      pr_url: null,
      pr_number: null,
      security_alert_url: 'https://github.com/acme/app/security/dependabot/7',
      security_alert_number: 7,
      advisory_url:
        'https://github.com/acme/app/security/advisories/GHSA-892v-qq52-xprh',
      advisory_ghsa_id: 'GHSA-892v-qq52-xprh',
    },
  }),
  useProjects: () => ({
    data: [{ id: 'project-1', path: '/repo', name: 'app' }],
  }),
  useOpenWorktreeInFinder: () => ({ mutate: vi.fn() }),
  useOpenWorktreeInTerminal: () => ({ mutate: vi.fn() }),
  useOpenWorktreeInEditor: () => ({ mutate: vi.fn() }),
  usePorts: () => ({ data: [] }),
}))

vi.mock('@/services/github', () => ({
  useLoadedIssueContexts: () => ({ data: [] }),
  useLoadedPRContexts: () => ({ data: [] }),
  useLoadedSecurityContexts: vi.fn((sessionId: string, worktreeId: string) => ({
    data:
      sessionId === 'session-1' && worktreeId === 'wt-1'
        ? [
            {
              number: 9,
              packageName: 'lodash',
              summary: 'Prototype pollution',
              severity: 'high',
              repoOwner: 'acme',
              repoName: 'app',
            },
          ]
        : [],
  })),
  useLoadedAdvisoryContexts: vi.fn((sessionId: string, worktreeId: string) => ({
    data:
      sessionId === 'session-1' && worktreeId === 'wt-1'
        ? [
            {
              ghsaId: 'GHSA-loaded-1234-5678',
              summary: 'Loaded advisory',
              severity: 'critical',
              repoOwner: 'acme',
              repoName: 'app',
            },
          ]
        : [],
  })),
}))

describe('OpenInModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows worktree and loaded security/advisory context URLs', async () => {
    render(<OpenInModal />)

    expect(
      await screen.findByText('Advisory GHSA-892v-qq52-xprh')
    ).toBeInTheDocument()
    expect(screen.getByText('Security #7')).toBeInTheDocument()
    expect(screen.getByText('Security #9')).toBeInTheDocument()
    expect(
      screen.getByText('Advisory GHSA-loaded-1234-5678')
    ).toBeInTheDocument()
  })
})
