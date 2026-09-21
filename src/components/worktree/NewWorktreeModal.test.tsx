import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { NewWorktreeModal } from './NewWorktreeModal'
import type * as EnvironmentModule from '@/lib/environment'
import type * as PreferencesModule from '@/services/preferences'

const mocks = vi.hoisted(() => ({
  isMobile: false,
  isNativeApp: false,
  preferences: {
    default_backend: 'codex',
    selected_model: 'sonnet',
    magic_prompt_models: {
      investigate_issue_model: 'gpt-5.6-sol-fast',
      investigate_pr_model: 'sonnet',
    },
    magic_prompt_backends: { investigate_pr_backend: 'claude' },
    custom_cli_profiles: [{ name: 'Team', settings_json: '{}' }],
  },
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => mocks.isNativeApp,
}))

vi.mock('@/services/preferences', async importOriginal => ({
  ...(await importOriginal<typeof PreferencesModule>()),
  usePreferences: () => ({ data: mocks.preferences }),
}))
vi.mock('@/hooks/useGhLogin', () => ({ useGhLogin: () => ({}) }))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: ['claude', 'codex'] }),
}))
vi.mock('./hooks/useNewWorktreeData', () => ({
  useNewWorktreeData: () => ({
    selectedProjectId: 'project-1',
    selectedProject: { name: 'Test' },
    projects: [{ id: 'project-1', name: 'Test' }],
    branches: [],
    remotes: [],
    createWorktree: {},
    createBaseSession: {},
  }),
}))
vi.mock('./hooks/useNewWorktreeHandlers', () => ({
  useNewWorktreeHandlers: () => ({}),
}))
vi.mock('./hooks/useNewWorktreeKeyboard', () => ({
  useNewWorktreeKeyboard: () => ({}),
}))
vi.mock('./GitHubIssuesTab', () => ({ GitHubIssuesTab: () => null }))
vi.mock('./GitHubPRsTab', () => ({ GitHubPRsTab: () => null }))
vi.mock('./QuickActionsTab', () => ({ QuickActionsTab: () => null }))

beforeEach(() => {
  mocks.isMobile = false
  mocks.isNativeApp = false
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
  useUIStore.setState({
    newWorktreeModalOpen: true,
    newWorktreeModalDefaultTab: 'issues',
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {
        return undefined
      }
      unobserve() {
        return undefined
      }
      disconnect() {
        return undefined
      }
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

describe('NewWorktreeModal prompt-first flow', () => {
  it('opens the selected context tab', () => {
    render(<NewWorktreeModal />)
    expect(screen.getByRole('button', { name: /Issues/ })).toHaveAttribute(
      'class',
      expect.stringContaining('border-primary')
    )
  })

  it('exposes the AI pipeline source', async () => {
    const user = userEvent.setup()
    render(<NewWorktreeModal />)
    await user.click(screen.getByRole('button', { name: /Pipeline IA/ }))
    expect(screen.getByRole('button', { name: /Pipeline IA/ })).toHaveAttribute(
      'class',
      expect.stringContaining('border-primary')
    )
  })

  it('returns to the prompt composer', async () => {
    const user = userEvent.setup()
    render(<NewWorktreeModal />)
    await user.click(screen.getByRole('button', { name: 'Back to prompt' }))
    expect(screen.getByText('Start something new')).toBeInTheDocument()
  })
})
