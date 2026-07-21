import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { WorktreeCiDot } from './WorktreeCiDot'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

const mockCached = vi.fn()
vi.mock('@/services/jenkins', () => ({
  useJenkinsStatusCached: (id: string | null) => mockCached(id),
}))

function statusWith(
  partial: Partial<JenkinsWorktreeStatus>
): JenkinsWorktreeStatus {
  return {
    worktreeId: 'wt1',
    prId: '42',
    pipeline: null,
    stages: [],
    integrationAttempts: [],
    preview: null,
    previewUrl: null,
    previewFreshness: null,
    queue: null,
    overallStatus: 'UNKNOWN',
    verdictSource: 'jenkins',
    checkedAt: 0,
    ...partial,
  }
}

beforeEach(() => mockCached.mockReset())

describe('WorktreeCiDot', () => {
  it('renders nothing without a PR', () => {
    mockCached.mockReturnValue({
      data: statusWith({ overallStatus: 'FAILURE' }),
    })
    const { container } = render(<WorktreeCiDot worktreeId="wt1" prId={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['BUILDING', 'Pipeline en cours — ce worktree travaille'],
    ['FAILURE', 'Pipeline en échec — à corriger'],
    ['QUEUED', "Pipeline en file d'attente"],
  ])(
    'shows an actionable dot with a tooltip for %s',
    (overallStatus, label) => {
      mockCached.mockReturnValue({ data: statusWith({ overallStatus }) })
      const { getByLabelText } = render(
        <WorktreeCiDot worktreeId="wt1" prId="42" />
      )
      expect(getByLabelText(label)).toBeInTheDocument()
    }
  )

  it('stays silent on SUCCESS (no noise for healthy worktrees)', () => {
    mockCached.mockReturnValue({
      data: statusWith({ overallStatus: 'SUCCESS' }),
    })
    const { container } = render(<WorktreeCiDot worktreeId="wt1" prId="42" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('surfaces a down preview even when CI is green', () => {
    mockCached.mockReturnValue({
      data: statusWith({
        overallStatus: 'SUCCESS',
        previewUrl: 'https://42.preview.example.com',
        previewFreshness: {
          status: 'DOWN',
          previewSha: null,
          prHeadSha: null,
          behindBy: null,
        },
      }),
    })
    const { getByLabelText } = render(
      <WorktreeCiDot worktreeId="wt1" prId="42" />
    )
    expect(getByLabelText('Preview hors ligne')).toBeInTheDocument()
  })

  it('renders nothing until the poller cache is populated', () => {
    mockCached.mockReturnValue({ data: undefined })
    const { container } = render(<WorktreeCiDot worktreeId="wt1" prId="42" />)
    expect(container).toBeEmptyDOMElement()
  })
})
