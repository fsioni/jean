import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { QuickActionsTab } from './QuickActionsTab'
import type { ProjectRemote } from '@/services/projects'

const onCreateWorktree = vi.fn()
const onBaseSession = vi.fn()

function renderTab(props: Partial<Parameters<typeof QuickActionsTab>[0]> = {}) {
  return render(
    <QuickActionsTab
      hasBaseSession={false}
      onCreateWorktree={onCreateWorktree}
      onBaseSession={onBaseSession}
      isCreating={false}
      projectId="project-1"
      jeanConfig={null}
      defaultBranch="main"
      {...props}
    />
  )
}

const twoRemotes: ProjectRemote[] = [
  { name: 'origin', repo: 'coollabsio/jean' },
  { name: 'fork', repo: 'fsioni/jean' },
]

beforeEach(() => {
  onCreateWorktree.mockClear()
  onBaseSession.mockClear()
})

describe('QuickActionsTab', () => {
  describe('single remote (default behaviour)', () => {
    it('keeps the base session and generic new worktree actions', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      expect(screen.getByText('New Base Session')).toBeInTheDocument()
      expect(screen.getByText('New Worktree')).toBeInTheDocument()
      expect(screen.queryByText('origin/main')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Create' }))
      expect(onCreateWorktree).toHaveBeenCalledWith(undefined, undefined)
    })

    it('passes the custom branch name without a base branch', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: [{ name: 'origin' }] })

      await user.type(screen.getByLabelText('Branch name'), 'my-feature')
      await user.click(screen.getByRole('button', { name: 'Create' }))

      expect(onCreateWorktree).toHaveBeenCalledWith('my-feature', undefined)
    })
  })

  describe('several remotes', () => {
    it('shows one create action per remote instead of the generic one', () => {
      renderTab({ remotes: twoRemotes })

      expect(screen.getByText('origin/main')).toBeInTheDocument()
      expect(screen.getByText('fork/main')).toBeInTheDocument()
      expect(
        screen.getByText('New worktree from coollabsio/jean')
      ).toBeInTheDocument()
      expect(
        screen.getByText('New worktree from fsioni/jean')
      ).toBeInTheDocument()
      expect(screen.queryByText('New Worktree')).not.toBeInTheDocument()
    })

    it('creates from the selected remote base branch', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.click(screen.getByText('fork/main'))
      expect(onCreateWorktree).toHaveBeenCalledWith(undefined, 'fork/main')

      await user.click(screen.getByText('origin/main'))
      expect(onCreateWorktree).toHaveBeenLastCalledWith(
        undefined,
        'origin/main'
      )
    })

    it('shares the custom branch name across both remotes', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.type(screen.getByLabelText('Branch name'), 'hotfix')
      await user.click(screen.getByText('fork/main'))

      expect(onCreateWorktree).toHaveBeenCalledWith('hotfix', 'fork/main')
    })

    it('creates from the first remote when pressing Enter in the name field', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.type(screen.getByLabelText('Branch name'), 'hotfix{Enter}')

      expect(onCreateWorktree).toHaveBeenCalledWith('hotfix', 'origin/main')
    })

    it('rejects invalid branch names', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes })

      await user.type(screen.getByLabelText('Branch name'), 'bad name')
      expect(screen.getByText('Invalid branch name')).toBeInTheDocument()

      await user.click(screen.getByText('fork/main'))
      expect(onCreateWorktree).not.toHaveBeenCalled()
    })

    it('keeps the base session reachable as a secondary action', async () => {
      const user = userEvent.setup()
      renderTab({ remotes: twoRemotes, hasBaseSession: true })

      await user.click(
        screen.getByRole('button', { name: /Switch to Base Session/ })
      )
      expect(onBaseSession).toHaveBeenCalled()
    })

    it('falls back to the generic action when the default branch is unknown', () => {
      renderTab({ remotes: twoRemotes, defaultBranch: undefined })

      expect(screen.getByText('New Worktree')).toBeInTheDocument()
      expect(screen.queryByText('origin/main')).not.toBeInTheDocument()
    })
  })
})
