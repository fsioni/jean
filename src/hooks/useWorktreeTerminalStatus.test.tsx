import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@/test/test-utils'
import type { PortEntry } from '@/services/projects'
import { WorkspacePortBadge } from './useWorktreeTerminalStatus'

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  ports: [] as PortEntry[],
  runs: [
    {
      worktreeId: 'workspace-1',
      status: 'running',
    },
  ],
}))

vi.mock('@/lib/platform', () => ({
  openExternal: mocks.openExternal,
}))

vi.mock('@/services/projects', () => ({
  usePorts: () => ({ data: mocks.ports }),
  useTerminalListeningPorts: () => ({ data: [] }),
}))

vi.mock('@/services/managed-runs', () => ({
  useProjectRuns: () => ({ data: mocks.runs }),
  useRunEnvironment: () => ({
    data: { basePort: 55120, portCount: 3 },
  }),
  useReallocateWorkspacePorts: () => ({ isPending: false, mutate: vi.fn() }),
  useStopWorkspaceRuns: () => ({ isPending: false, mutate: vi.fn() }),
}))

describe('WorkspacePortBadge external browser actions', () => {
  beforeEach(() => {
    mocks.openExternal.mockReset()
    mocks.ports = []
    mocks.runs = [{ worktreeId: 'workspace-1', status: 'running' }]
  })

  it('opens the single resolved app port in the default browser', async () => {
    mocks.ports = [{ port: 55120, label: 'Web' }]
    const user = userEvent.setup()
    render(
      <WorkspacePortBadge
        worktreeId="workspace-1"
        projectId="project-1"
        worktreePath="/tmp/workspace-1"
      />
    )

    await user.click(
      screen.getByRole('button', {
        name: 'Open Web in default browser',
      })
    )

    expect(mocks.openExternal).toHaveBeenCalledWith('http://localhost:55120')
  })

  it('offers every resolved service when several app ports are declared', async () => {
    mocks.ports = [
      { port: 55120, label: 'Web' },
      { port: 55121, label: 'API' },
    ]
    const user = userEvent.setup()
    render(
      <WorkspacePortBadge
        worktreeId="workspace-1"
        projectId="project-1"
        worktreePath="/tmp/workspace-1"
      />
    )

    await user.click(
      screen.getByRole('button', {
        name: 'Open app port in default browser',
      })
    )
    await user.click(screen.getByRole('menuitem', { name: /API/ }))

    expect(mocks.openExternal).toHaveBeenCalledWith('http://localhost:55121')
  })

  it('keeps browser actions disabled until the managed Run is ready', () => {
    mocks.ports = [{ port: 55120, label: 'Web' }]
    mocks.runs = []
    render(
      <WorkspacePortBadge
        worktreeId="workspace-1"
        projectId="project-1"
        worktreePath="/tmp/workspace-1"
      />
    )

    expect(
      screen.getByRole('button', {
        name: 'Open Web in default browser',
      })
    ).toBeDisabled()
  })
})
