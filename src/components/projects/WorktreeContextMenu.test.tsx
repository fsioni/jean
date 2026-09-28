import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Worktree } from '@/types/projects'
import { WorktreeContextMenu } from './WorktreeContextMenu'
import type { useWorktreeMenuActions } from './useWorktreeMenuActions'

vi.mock('@/lib/environment', () => ({
  canOpenInEditor: () => false,
  canOpenInFinder: () => false,
  canOpenInTerminal: () => false,
}))
vi.mock('./StandbyDialog', () => ({ StandbyDialog: () => null }))

const worktree: Worktree = {
  id: 'wt-42',
  project_id: 'project-1',
  name: 'feature',
  path: '/tmp/project/feature',
  branch: 'CU-123-feature',
  pr_number: 42,
  created_at: 0,
  order: 0,
}

function renderMenu(overrides: Record<string, unknown> = {}) {
  const handleFinishPr = vi.fn()
  function Harness() {
    const [showFinishConfirm, setShowFinishConfirm] = useState(false)
    const actions = {
      showDeleteConfirm: false,
      setShowDeleteConfirm: vi.fn(),
      showStandbyDialog: false,
      setShowStandbyDialog: vi.fn(),
      showFinishConfirm,
      setShowFinishConfirm,
      setIsContextMenuOpen: vi.fn(),
      isBase: false,
      isStandby: false,
      runScripts: [],
      preferences: {},
      handleArchiveOrClose: vi.fn(),
      handleDelete: vi.fn(),
      handleSetStandby: vi.fn(),
      handleClearStandby: vi.fn(),
      isUpdatingStandby: false,
      canFinishPr: true,
      handleFinishPr,
      isFinishingPr: false,
      ...overrides,
    } as unknown as ReturnType<typeof useWorktreeMenuActions>
    return (
      <WorktreeContextMenu actions={actions} worktree={worktree}>
        <div>feature</div>
      </WorktreeContextMenu>
    )
  }
  render(<Harness />)
  fireEvent.contextMenu(screen.getByText('feature'))
  return { handleFinishPr }
}

describe('WorktreeContextMenu', () => {
  it('offers the TO DEPLOY + merge action for a linked PR worktree', async () => {
    renderMenu()
    expect(
      await screen.findByRole('menuitem', {
        name: /TO DEPLOY.*merge.*PR/i,
      })
    ).toBeInTheDocument()
  })

  it('does not offer the finish action for a base worktree', async () => {
    renderMenu({ isBase: true })
    await screen.findByRole('menuitem', { name: 'Close Session' })
    expect(
      screen.queryByRole('menuitem', { name: /TO DEPLOY.*merge.*PR/i })
    ).not.toBeInTheDocument()
  })

  it('requires confirmation before running the finish action', async () => {
    const { handleFinishPr } = renderMenu()
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /TO DEPLOY.*merge.*PR/i })
    )
    expect(await screen.findByText('Terminer la PR #42 ?')).toBeInTheDocument()
    expect(handleFinishPr).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }))
    expect(handleFinishPr).toHaveBeenCalledOnce()
  })
})
import { useState } from 'react'
