import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { MissionControlData } from './useMissionControlRows'

const mockData = vi.fn<() => MissionControlData>()
const mockSetOpen = vi.fn()

vi.mock('./useMissionControlRows', () => ({
  useMissionControlRows: () => mockData(),
}))
vi.mock('./MissionControlRow', () => ({
  MissionControlRow: ({
    row,
  }: {
    row: { worktree: { name: string }; status?: { overallStatus: string } }
  }) => (
    <div data-testid="row">
      {row.worktree.name}:{row.status?.overallStatus ?? 'none'}
    </div>
  ),
}))
vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: { getState: () => ({ setMissionControlOpen: mockSetOpen }) },
}))

import { MissionControlView } from './MissionControlView'

function mkRow(name: string, overallStatus?: string) {
  return {
    project: { id: 'p1', name: 'Proj' },
    worktree: { id: name, name, branch: 'feat', pr_url: null },
    prId: '1',
    status: overallStatus ? { overallStatus } : undefined,
  } as unknown as MissionControlData['rows'][number]
}

function data(partial: Partial<MissionControlData>): MissionControlData {
  return {
    rows: [],
    jenkinsProjectCount: 1,
    failureCount: 0,
    isLoading: false,
    ...partial,
  }
}

beforeEach(() => {
  mockData.mockReset()
  mockSetOpen.mockReset()
})

describe('MissionControlView', () => {
  it('renders one row per PR and surfaces the failure count', () => {
    mockData.mockReturnValue(
      data({
        rows: [mkRow('alpha', 'FAILURE'), mkRow('beta', 'SUCCESS')],
        failureCount: 1,
      })
    )
    const { getAllByTestId, getByText } = render(<MissionControlView />)
    expect(getAllByTestId('row')).toHaveLength(2)
    expect(getByText(/1 en échec/)).toBeInTheDocument()
  })

  it('filters rows by the search query', () => {
    mockData.mockReturnValue(
      data({ rows: [mkRow('alpha', 'FAILURE'), mkRow('beta', 'SUCCESS')] })
    )
    const { getByPlaceholderText, getAllByTestId } = render(
      <MissionControlView />
    )
    fireEvent.change(
      getByPlaceholderText('Rechercher (projet, worktree, branche, PR#)…'),
      { target: { value: 'alph' } }
    )
    const rows = getAllByTestId('row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('alpha')
  })

  it('filters rows by the status chip (icon + label, not color alone)', () => {
    mockData.mockReturnValue(
      data({ rows: [mkRow('alpha', 'FAILURE'), mkRow('beta', 'SUCCESS')] })
    )
    const { getByText, getAllByTestId } = render(<MissionControlView />)
    fireEvent.click(getByText('Échecs'))
    const rows = getAllByTestId('row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('alpha')
  })

  it('shows a config empty state when no project has Jenkins', () => {
    mockData.mockReturnValue(data({ jenkinsProjectCount: 0 }))
    const { getByText } = render(<MissionControlView />)
    expect(getByText('Aucun projet Jenkins configuré')).toBeInTheDocument()
  })

  it('shows a "no PR" empty state when configured but no PR worktrees', () => {
    mockData.mockReturnValue(data({ rows: [], jenkinsProjectCount: 2 }))
    const { getByText } = render(<MissionControlView />)
    expect(getByText('Aucune PR active')).toBeInTheDocument()
  })
})
