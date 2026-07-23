import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { PreviewBadge } from './PreviewBadge'
import type { JenkinsWorktreeStatus, PreviewFreshness } from '@/types/jenkins'

const mockUseJenkinsStatus = vi.fn()

vi.mock('@/services/jenkins', () => ({
  useJenkinsStatus: (
    projectId: string,
    worktreeId: string,
    prId?: string | null,
    branch?: string | null
  ) => mockUseJenkinsStatus(projectId, worktreeId, prId, branch),
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const SHA_PREVIEW = '9a54f3bafc2fa898b06a5fb0b48bae73af92963f'
const SHA_HEAD = 'ffffffffffffffffffffffffffffffffffffffff'

function statusWith(freshness: PreviewFreshness | null): JenkinsWorktreeStatus {
  return {
    worktreeId: 'wt-1',
    prId: '42',
    pipeline: null,
    stages: [],
    integrationAttempts: [],
    preview: null,
    previewUrl: 'https://42.preview.example.com/admin',
    previewFreshness: freshness,
    queue: null,
    overallStatus: 'SUCCESS',
    verdictSource: 'jenkins',
    checkedAt: 0,
  }
}

function renderBadge(freshness: PreviewFreshness | null) {
  mockUseJenkinsStatus.mockReturnValue({ data: statusWith(freshness) })
  return render(
    <PreviewBadge projectId="p1" worktreeId="wt-1" prId="42" branch="feat" />
  )
}

beforeEach(() => {
  mockUseJenkinsStatus.mockReset()
})

describe('PreviewBadge', () => {
  it('renders nothing until there is a preview URL', () => {
    mockUseJenkinsStatus.mockReturnValue({
      data: { ...statusWith(null), previewUrl: null },
    })
    const { container } = render(
      <PreviewBadge projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('states the freshness in the tooltip, not by colour alone', () => {
    const { getByRole } = renderBadge({
      status: 'UP_TO_DATE',
      previewSha: SHA_PREVIEW,
      shaSource: 'preview',
      prHeadSha: SHA_PREVIEW,
      behindBy: 0,
    })
    expect(getByRole('button')).toHaveAttribute(
      'title',
      'Preview à jour avec la PR'
    )
  })

  it('hedges the wording when the commit only comes from Jenkins', () => {
    // Preview up but publishing no `/version`: the SHA is the last successful
    // deploy's REVISION — deployed, not necessarily served.
    const { getByRole } = renderBadge({
      status: 'UP_TO_DATE',
      previewSha: SHA_PREVIEW,
      shaSource: 'jenkins',
      prHeadSha: SHA_PREVIEW,
      behindBy: 0,
    })
    expect(getByRole('button')).toHaveAttribute(
      'title',
      "Preview à jour avec la PR (d'après Jenkins)"
    )
  })

  it('keeps the preview-served wording unqualified', () => {
    const { getByRole } = renderBadge({
      status: 'STALE',
      previewSha: SHA_PREVIEW,
      shaSource: 'preview',
      prHeadSha: SHA_HEAD,
      behindBy: 3,
    })
    expect(getByRole('button')).toHaveAttribute(
      'title',
      'Preview périmée — en retard de 3 commits'
    )
  })
})
