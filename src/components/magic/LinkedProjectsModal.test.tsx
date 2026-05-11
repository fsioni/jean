import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { LinkedProjectsModal } from './LinkedProjectsModal'

const mutateMock = vi.fn()
let projectsMock: Project[] = []

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: projectsMock }),
  useUpdateProjectSettings: () => ({ mutate: mutateMock }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

function project(overrides: Partial<Project>): Project {
  return {
    id: 'project-id',
    name: 'project-name',
    path: '/tmp/project-name',
    default_branch: 'main',
    added_at: 1,
    order: 1,
    ...overrides,
  }
}

function renderModal() {
  return render(
    <LinkedProjectsModal
      open
      onOpenChange={vi.fn()}
      projectId="current-project"
    />
  )
}

describe('LinkedProjectsModal', () => {
  beforeEach(() => {
    mutateMock.mockReset()
    projectsMock = [
      project({
        id: 'current-project',
        name: 'current',
        linked_project_ids: ['architecture'],
      }),
      project({ id: 'architecture', name: 'architecture' }),
      project({ id: 'jean', name: 'jean' }),
      project({ id: 'coolify', name: 'coolify' }),
      project({ id: 'coolify-io', name: 'coolify.io' }),
      project({ id: 'coolpack', name: 'coolpack' }),
      project({ id: 'folder', name: 'folder', is_folder: true }),
    ]
  })

  it('adds the selected visible project with ArrowDown and Enter', async () => {
    const user = userEvent.setup()
    renderModal()

    const search = screen.getByPlaceholderText('Search projects...')
    await user.click(search)
    await user.keyboard('{ArrowDown}{Enter}')

    expect(mutateMock).toHaveBeenCalledWith(
      {
        projectId: 'current-project',
        linkedProjectIds: ['architecture', 'coolify'],
      },
      expect.any(Object)
    )
  })

  it('uses filtered results for Enter selection', async () => {
    const user = userEvent.setup()
    renderModal()

    const search = screen.getByPlaceholderText('Search projects...')
    await user.type(search, 'pack')
    await user.keyboard('{Enter}')

    expect(mutateMock).toHaveBeenCalledWith(
      {
        projectId: 'current-project',
        linkedProjectIds: ['architecture', 'coolpack'],
      },
      expect.any(Object)
    )
  })

  it('uses a distinct input surface from the modal background', () => {
    renderModal()

    expect(screen.getByPlaceholderText('Search projects...')).toHaveClass(
      'bg-muted/40',
      'dark:bg-input/50',
      'shadow-sm'
    )
  })
})
