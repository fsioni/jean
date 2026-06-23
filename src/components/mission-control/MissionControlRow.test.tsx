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

function mkRow(
  overallStatus: string,
  building: boolean,
  stages: JenkinsStage[]
): Row {
  return {
    project: { id: 'p1', name: 'Proj' },
    worktree: { id: 'wt1', name: 'alpha', branch: 'feat', pr_url: null },
    prId: '42',
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
  { name: 'Unit tests', status: 'SUCCESS', durationMs: 1000 },
  { name: 'Integration tests', status: 'IN_PROGRESS', durationMs: 0 },
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
    expect(getByTitle('Integration tests : en cours')).toBeInTheDocument()
  })

  it('keeps a finished build collapsed until the chevron is clicked', () => {
    const finished: JenkinsStage[] = [
      { name: 'Unit tests', status: 'SUCCESS', durationMs: 1000 },
      { name: 'Integration tests', status: 'SUCCESS', durationMs: 5000 },
    ]
    const { queryByText, getByLabelText, getByText } = render(
      <MissionControlRow row={mkRow('SUCCESS', false, finished)} />
    )
    expect(queryByText('Unit tests')).toBeNull()
    fireEvent.click(getByLabelText('Déplier les étapes'))
    expect(getByText('Unit tests')).toBeInTheDocument()
  })

  it('shows no expand toggle when there are no stages', () => {
    const { queryByLabelText } = render(
      <MissionControlRow row={mkRow('UNKNOWN', false, [])} />
    )
    expect(queryByLabelText('Déplier les étapes')).toBeNull()
    expect(queryByLabelText('Replier les étapes')).toBeNull()
  })
})
