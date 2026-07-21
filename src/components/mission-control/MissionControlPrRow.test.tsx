import { describe, expect, it, vi, beforeEach } from 'vitest'
import type * as ReactQuery from '@tanstack/react-query'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { MissionControlPrRow as PrRow } from './useMissionControlRows'

const mockInvoke = vi.fn()
const mockOpenUrl = vi.fn()
const setMissionControlOpen = vi.fn()
const setActiveWorktree = vi.fn()
const selectWorktree = vi.fn()

vi.mock('@/lib/transport', () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }))
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...a: unknown[]) => mockOpenUrl(...a),
}))
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 't1'),
    success: vi.fn(),
    error: vi.fn(),
  },
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: { getState: () => ({ setMissionControlOpen }) },
}))
vi.mock('@/store/chat-store', () => ({
  useChatStore: { getState: () => ({ setActiveWorktree }) },
}))
vi.mock('@/store/projects-store', () => ({
  useProjectsStore: {
    getState: () => ({
      selectProject: vi.fn(),
      expandProject: vi.fn(),
      selectWorktree,
    }),
  },
}))

import { MissionControlPrRow } from './MissionControlPrRow'

function mkRow(partial?: Partial<PrRow>): PrRow {
  return {
    project: { id: 'p1', name: 'Proj' },
    pr: {
      number: 4118,
      title: 'Modale de reconnexion',
      state: 'OPEN',
      headRefName: 'CU-86catgj22-modale-reconnexion',
      baseRefName: 'master',
      isDraft: false,
      created_at: '',
      author: { login: 'me' },
      labels: [],
      url: 'https://github.com/org/repo/pull/4118',
    },
    status: undefined,
    ...partial,
  } as unknown as PrRow
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockOpenUrl.mockReset()
  setMissionControlOpen.mockReset()
  setActiveWorktree.mockReset()
  selectWorktree.mockReset()
})

describe('MissionControlPrRow', () => {
  it('shows the PR, its branch and the CI verdict in words', () => {
    render(
      <MissionControlPrRow
        row={mkRow({
          status: { overallStatus: 'FAILURE' } as PrRow['status'],
        })}
      />
    )
    expect(screen.getByText('Modale de reconnexion')).toBeInTheDocument()
    expect(screen.getByText(/CU-86catgj22/)).toBeInTheDocument()
    expect(screen.getByText('Échec')).toBeInTheDocument()
  })

  it('says "Aucun build" rather than nothing when Jenkins knows no build', () => {
    render(<MissionControlPrRow row={mkRow()} />)
    expect(screen.getByText('Aucun build')).toBeInTheDocument()
  })

  it('checks the PR out and lands on the resulting worktree', async () => {
    mockInvoke.mockResolvedValue({ id: 'wt-new', path: '/tmp/wt-new' })
    render(<MissionControlPrRow row={mkRow()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Récupérer/ }))
    })

    expect(mockInvoke).toHaveBeenCalledWith('checkout_pr', {
      projectId: 'p1',
      prNumber: 4118,
    })
    // Navigating away also dismisses Mission Control.
    expect(setMissionControlOpen).toHaveBeenCalledWith(false)
    expect(selectWorktree).toHaveBeenCalledWith('wt-new')
    expect(setActiveWorktree).toHaveBeenCalledWith('wt-new', '/tmp/wt-new')
  })

  it('keeps the row usable when the checkout fails', async () => {
    mockInvoke.mockRejectedValue('boom')
    render(<MissionControlPrRow row={mkRow()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Récupérer/ }))
    })
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Récupérer/ })).toBeEnabled()
  })

  it('opens the PR on GitHub', () => {
    render(<MissionControlPrRow row={mkRow()} />)
    fireEvent.click(screen.getByTitle('Ouvrir la PR sur GitHub'))
    expect(mockOpenUrl).toHaveBeenCalledWith(
      'https://github.com/org/repo/pull/4118'
    )
  })
})
