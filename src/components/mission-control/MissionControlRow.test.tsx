import { describe, expect, it, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { JenkinsStage } from '@/types/jenkins'
import type { MissionControlRow as Row } from './useMissionControlRows'

// Heavy children / stores are mocked; JenkinsStageList stays real so we can
// assert the inline stage breakdown renders.
vi.mock('@/components/jenkins/JenkinsStatusBadge', () => ({
  JenkinsStatusBadge: () => null,
}))
vi.mock('@/components/jenkins/PreviewBadge', () => ({
  PreviewBadge: () => null,
}))
vi.mock('@/services/jenkins', () => ({
  useRerunJenkinsPipeline: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/services/git-status', () => ({
  useGitStatus: () => ({ data: null }),
}))
// Mounting the failure panel would fetch a report; it has its own test file.
vi.mock('@/components/jenkins/FailureReportPanel', () => ({
  FailureReportPanel: () => <div data-testid="failure-panel" />,
}))
vi.mock('@/store/chat-store', () => ({
  useChatStore: { getState: () => ({ clearActiveWorktree: vi.fn() }) },
}))
vi.mock('@/store/projects-store', () => ({
  useProjectsStore: {
    getState: () => ({
      selectProject: vi.fn(),
      expandProject: vi.fn(),
      selectWorktree: vi.fn(),
    }),
  },
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: { getState: () => ({ setMissionControlOpen: vi.fn() }) },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

import { MissionControlRow } from './MissionControlRow'
import { FLAKY_STAGE } from '@/components/jenkins/jenkins-jobs'

function mkRow(
  overallStatus: string,
  building: boolean,
  stages: JenkinsStage[]
): Row {
  return {
    project: { id: 'p1', name: 'Proj' },
    worktree: { id: 'wt1', name: 'alpha', branch: 'feat', pr_url: null },
    prId: '42',
    kind: 'linked',
    status: {
      worktreeId: 'wt1',
      overallStatus,
      pipeline: {
        number: 7,
        building,
        timestampMs: Date.now() - 60_000,
        durationMs: building ? 0 : 120_000,
        url: 'https://ci/7',
        result: building ? null : 'SUCCESS',
        prId: '42',
        branch: 'feat',
      },
      stages,
    },
  } as unknown as Row
}

const STAGES: JenkinsStage[] = [
  { name: 'Rust unit tests', status: 'SUCCESS', durationMs: 1000 },
  { name: FLAKY_STAGE, status: 'IN_PROGRESS', durationMs: 0 },
  { name: 'Deploy preview', status: 'NOT_EXECUTED', durationMs: 0 },
]

describe('MissionControlRow', () => {
  it('auto-expands a running build and shows the live stage progress', () => {
    const { getByText, getByTitle } = render(
      <MissionControlRow row={mkRow('BUILDING', true, STAGES)} />
    )
    // Inline stage list is visible without clicking (auto-expanded).
    expect(getByText('Deploy preview')).toBeInTheDocument()
    // Compact progress chip: running stage at position 2/3.
    expect(getByText('2/3')).toBeInTheDocument()
    // Stage status spelled out (colorblind-safe).
    expect(getByTitle(`${FLAKY_STAGE} : en cours`)).toBeInTheDocument()
  })

  it('keeps a finished build collapsed until the chevron is clicked', () => {
    const finished: JenkinsStage[] = [
      { name: 'Rust unit tests', status: 'SUCCESS', durationMs: 1000 },
      { name: FLAKY_STAGE, status: 'SUCCESS', durationMs: 5000 },
    ]
    const { queryByText, getByLabelText, getByText } = render(
      <MissionControlRow row={mkRow('SUCCESS', false, finished)} />
    )
    expect(queryByText('Rust unit tests')).toBeNull()
    fireEvent.click(getByLabelText('Déplier les étapes'))
    expect(getByText('Rust unit tests')).toBeInTheDocument()
  })

  it('shows no expand toggle when there are no stages', () => {
    const { queryByLabelText } = render(
      <MissionControlRow row={mkRow('UNKNOWN', false, [])} />
    )
    expect(queryByLabelText('Déplier les étapes')).toBeNull()
    expect(queryByLabelText('Replier les étapes')).toBeNull()
  })

  it('states the rank and wait when the run is stuck in the Jenkins queue', () => {
    const row = mkRow('QUEUED', false, [])
    Object.assign(row.status ?? {}, {
      queue: {
        why: 'Build #4798 is already in progress',
        sinceMs: Date.now() - 8 * 60_000,
        blocked: true,
        position: 2,
        total: 5,
      },
    })
    const { getByText } = render(<MissionControlRow row={row} />)
    expect(getByText('2/5')).toBeInTheDocument()
    expect(getByText(/8 min/)).toBeInTheDocument()
  })

  it('flags a branch that is behind its base as needing a rebase', () => {
    const row = mkRow('SUCCESS', false, [])
    ;(row.worktree as { cached_behind_count?: number }).cached_behind_count = 12
    const { getByText } = render(<MissionControlRow row={row} />)
    // Words + icon, never color alone.
    expect(getByText(/À rebase · 12/)).toBeInTheDocument()
  })

  it('marks a PR found on the branch while Jean had no link', () => {
    const row = mkRow('SUCCESS', false, [])
    Object.assign(row, {
      kind: 'detached',
      prId: '99',
      detectedPr: { number: 99, url: 'https://gh/pr/99' },
    })
    const { getByText } = render(<MissionControlRow row={row} />)
    expect(getByText(/#99/)).toBeInTheDocument()
    expect(getByText(/détectée/)).toBeInTheDocument()
  })

  it('says plainly when a worktree has no PR at all', () => {
    const row = mkRow('UNKNOWN', false, [])
    Object.assign(row, { kind: 'no-pr', prId: '' })
    const { getByText } = render(<MissionControlRow row={row} />)
    expect(getByText('pas de PR')).toBeInTheDocument()
  })

  it('opens the failure diagnosis from the "Pourquoi ?" shortcut', () => {
    const row = mkRow('FAILURE', false, [])
    const { getByRole, getByTestId, queryByTestId } = render(
      <MissionControlRow row={row} />
    )
    expect(queryByTestId('failure-panel')).toBeNull()
    fireEvent.click(getByRole('button', { name: /Pourquoi/ }))
    expect(getByTestId('failure-panel')).toBeInTheDocument()
  })
})
