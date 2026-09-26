import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ProjectsSidebar } from './ProjectsSidebar'

const mocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: [], isLoading: false, isError: false }),
  useCreateFolder: () => ({ mutate: mocks.createFolder, isPending: false }),
}))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: [] }),
}))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/components/layout/SidebarWidthContext', () => ({
  useSidebarWidth: () => 280,
}))
vi.mock('@/lib/server-connections', () => ({
  useServerConnectionSnapshots: () => new Map(),
}))
vi.mock('@/lib/environment', () => ({ isNativeApp: () => false }))
vi.mock('./ProjectTree', () => ({ ProjectTree: () => null }))
vi.mock('./RecentWorktreesList', () => ({ RecentWorktreesList: () => null }))

describe('ProjectsSidebar folder creation', () => {
  beforeEach(() => mocks.createFolder.mockReset())

  it('offers New folder in the search-row plus menu', async () => {
    const user = userEvent.setup()
    render(<ProjectsSidebar />)

    const search = screen.getByRole('searchbox', {
      name: 'Search projects and worktrees',
    })
    await user.type(search, 'old search')
    await user.click(
      screen.getByRole('button', { name: 'Add project or folder' })
    )
    expect(
      screen.getByRole('menuitem', { name: 'Add project' })
    ).toHaveAttribute('data-disabled')
    await user.click(screen.getByRole('menuitem', { name: 'New folder' }))

    expect(mocks.createFolder).toHaveBeenCalledWith({ name: 'New Folder' })
    expect(search).toHaveValue('')
  })
})
