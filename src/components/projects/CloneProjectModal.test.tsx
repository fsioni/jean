import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { CloneProjectModal } from './CloneProjectModal'
import { useProjectsStore } from '@/store/projects-store'

const saveMock = vi.fn()

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => saveMock(...args),
}))

describe('CloneProjectModal', () => {
  const longDestination =
    '/Users/stacylia/Developer/coolify/this is a long name for a folder'

  beforeEach(() => {
    vi.clearAllMocks()
    saveMock.mockResolvedValue(longDestination)
    ;(
      window as unknown as { __TAURI_INTERNALS__?: { invoke: () => void } }
    ).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    useProjectsStore.setState({
      cloneModalOpen: true,
      addProjectDialogOpen: true,
      addProjectParentFolderId: null,
    })
  })

  it('keeps long destination paths constrained and accessible', async () => {
    render(<CloneProjectModal />)

    const destinationButton = screen.getByRole('button', {
      name: /choose destination/i,
    })

    await userEvent.click(destinationButton)

    const updatedDestinationButton = await screen.findByRole('button', {
      name: longDestination,
    })
    const destinationText = within(updatedDestinationButton).getByText(
      longDestination
    )
    const destinationPreview = screen.getByText(longDestination, {
      selector: 'p',
    })

    expect(updatedDestinationButton).toHaveClass(
      'min-w-0',
      'flex-1',
      'overflow-hidden'
    )
    expect(updatedDestinationButton).toHaveAttribute('title', longDestination)
    expect(destinationText).toHaveClass(
      'min-w-0',
      'flex-1',
      'truncate',
      'text-left'
    )
    expect(destinationPreview).toHaveClass('max-w-full', 'truncate')
    expect(destinationPreview).toHaveAttribute('title', longDestination)
  })
})
