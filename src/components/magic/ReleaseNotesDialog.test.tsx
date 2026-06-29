import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { ReleaseNotesDialog } from './ReleaseNotesDialog'

const mocks = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  setReleaseNotesModalOpen: vi.fn(),
  triggerLogin: vi.fn(),
  copyToClipboard: vi.fn(),
  openExternal: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invokeMock }))
vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    releaseNotesModalOpen: true,
    setReleaseNotesModalOpen: mocks.setReleaseNotesModalOpen,
  }),
}))
vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (
    selector: (state: { selectedProjectId: string }) => unknown
  ) => selector({ selectedProjectId: 'project-1' }),
}))
vi.mock('@/services/projects', () => ({
  useProjects: () => ({
    data: [{ id: 'project-1', name: 'Jean', path: '/repo' }],
  }),
}))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))
vi.mock('@/types/preferences', () => ({
  resolveMagicPromptProvider: () => undefined,
}))
vi.mock('@/hooks/useGhLogin', () => ({
  useGhLogin: () => ({ triggerLogin: mocks.triggerLogin, isGhInstalled: true }),
}))
vi.mock('@/services/github', () => ({
  isGhAuthError: () => false,
}))
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: mocks.copyToClipboard }))
vi.mock('@/lib/platform', () => ({ openExternal: mocks.openExternal }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('ReleaseNotesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invokeMock.mockImplementation((command: string) => {
      if (command === 'list_github_releases') {
        return Promise.resolve([
          {
            tagName: 'v0.1.59',
            name: 'Previous release',
            publishedAt: '2026-06-20T00:00:00Z',
            isLatest: true,
            isDraft: false,
            isPrerelease: false,
          },
        ])
      }
      if (command === 'get_github_repo_url') {
        return Promise.resolve('https://github.com/example/jean')
      }
      if (command === 'generate_release_notes') {
        return Promise.resolve({
          title: 'v0.1.60 - Notifications, Backend Setup & Chat',
          body: 'Release notes body',
        })
      }
      return Promise.resolve(null)
    })
  })

  it('stacks result action buttons on mobile and restores an inline row on larger screens', async () => {
    const user = userEvent.setup()
    render(<ReleaseNotesDialog />)

    await user.click(
      await screen.findByRole('button', { name: /previous release/i })
    )
    await screen.findByDisplayValue(
      'v0.1.60 - Notifications, Backend Setup & Chat'
    )

    const regenerateButton = screen.getByRole('button', { name: /regenerate/i })
    const actions = regenerateButton.parentElement

    expect(actions).toHaveClass('flex-col', 'sm:flex-row')
    expect(regenerateButton).toHaveClass('w-full', 'sm:w-auto')
    expect(
      screen.getByRole('button', { name: /create on github/i })
    ).toHaveClass('w-full', 'sm:w-auto')
    expect(screen.getByRole('button', { name: /^copy$/i })).toHaveClass(
      'w-full',
      'sm:w-auto'
    )
    expect(within(actions as HTMLElement).getAllByRole('button')).toHaveLength(
      3
    )
  })
})
