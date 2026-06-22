import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { WorktreeStatusDot } from './WorktreeStatusDot'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

const mockUseJenkinsStatusCached = vi.fn()
const mockUseProjects = vi.fn()

vi.mock('@/services/jenkins', () => ({
  useJenkinsStatusCached: (id: string | null) => mockUseJenkinsStatusCached(id),
}))
vi.mock('@/services/projects', () => ({
  useProjects: () => mockUseProjects(),
}))

function statusWith(
  partial: Partial<JenkinsWorktreeStatus>
): JenkinsWorktreeStatus {
  return {
    worktreeId: 'wt-1',
    prId: '42',
    pipeline: {
      number: 7,
      result: 'SUCCESS',
      building: false,
      timestampMs: 0,
      durationMs: 1000,
      url: '',
      prId: '42',
      branch: 'feature',
    },
    stages: [],
    preview: null,
    previewUrl: null,
    previewFreshness: null,
    queue: null,
    overallStatus: 'SUCCESS',
    checkedAt: 0,
    ...partial,
  }
}

const UNCONFIGURED_SENTINEL: JenkinsWorktreeStatus = {
  worktreeId: 'wt-1',
  prId: '42',
  pipeline: null,
  stages: [],
  preview: null,
  previewUrl: null,
  previewFreshness: null,
  queue: null,
  overallStatus: 'UNKNOWN',
  checkedAt: 0,
}

beforeEach(() => {
  mockUseJenkinsStatusCached.mockReset()
  mockUseProjects.mockReset()
  mockUseProjects.mockReturnValue({ data: [] })
})

describe('WorktreeStatusDot', () => {
  it('renders nothing without a PR (the badge lives at the PR level)', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: undefined })
    const { container } = render(
      <WorktreeStatusDot projectId="p1" worktreeId="wt-1" prId={null} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['SUCCESS', 'bg-green-500'],
    ['FAILURE', 'bg-red-500'],
    ['BUILDING', 'bg-blue-500'],
    ['QUEUED', 'bg-amber-500'],
  ])('renders the %s verdict dot (%s)', (overallStatus, dotClass) => {
    mockUseJenkinsStatusCached.mockReturnValue({
      data: statusWith({ overallStatus }),
    })
    const { container } = render(
      <WorktreeStatusDot projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(container.querySelector(`.${dotClass}`)).not.toBeNull()
  })

  it('adds a preview-freshness dot when the preview is stale', () => {
    mockUseJenkinsStatusCached.mockReturnValue({
      data: statusWith({
        overallStatus: 'SUCCESS',
        previewUrl: 'https://42.preview.example.com',
        previewFreshness: {
          status: 'STALE',
          previewSha: 'aaa',
          prHeadSha: 'bbb',
          behindBy: 2,
        },
      }),
    })
    const { container } = render(
      <WorktreeStatusDot projectId="p1" worktreeId="wt-1" prId="42" />
    )
    // Verdict (green) + preview freshness (amber) dots both present.
    expect(container.querySelector('.bg-green-500')).not.toBeNull()
    expect(container.querySelector('.bg-amber-500')).not.toBeNull()
  })

  it('shows the "not configured" hint for a PR worktree when the project lacks Jenkins config', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: undefined })
    mockUseProjects.mockReturnValue({ data: [{ id: 'p1' }] })
    const { getByText } = render(
      <WorktreeStatusDot projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(getByText('CI')).toBeInTheDocument()
  })

  it('renders nothing while configured but not yet polled (no spurious hint)', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: undefined })
    mockUseProjects.mockReturnValue({
      data: [{ id: 'p1', jenkins_url: 'https://ci.example.com' }],
    })
    const { container } = render(
      <WorktreeStatusDot projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('treats the unconfigured sentinel as "no data" (shows the hint, not an UNKNOWN dot)', () => {
    mockUseJenkinsStatusCached.mockReturnValue({ data: UNCONFIGURED_SENTINEL })
    mockUseProjects.mockReturnValue({ data: [{ id: 'p1' }] })
    const { getByText, container } = render(
      <WorktreeStatusDot projectId="p1" worktreeId="wt-1" prId="42" />
    )
    expect(getByText('CI')).toBeInTheDocument()
    // No verdict dot for an UNKNOWN sentinel.
    expect(container.querySelector('.bg-green-500')).toBeNull()
    expect(container.querySelector('.bg-red-500')).toBeNull()
  })
})
