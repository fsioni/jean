import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { JenkinsStageList } from './JenkinsStageList'
import { FLAKY_STAGE } from './jenkins-jobs'
import type { JenkinsAttempt, JenkinsStage } from '@/types/jenkins'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

function stage(partial: Partial<JenkinsStage>): JenkinsStage {
  return { name: 'Stage', status: 'SUCCESS', durationMs: 1000, ...partial }
}

function attempt(partial: Partial<JenkinsAttempt>): JenkinsAttempt {
  return {
    attempt: 1,
    result: 'FAILURE',
    building: false,
    durationMs: 1000,
    url: 'https://ci/job/unified-build-test-deploy/61/execution/node/84/log',
    ...partial,
  }
}

describe('JenkinsStageList', () => {
  it('renders nothing when there are no stages', () => {
    const { container } = render(<JenkinsStageList stages={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists each stage with a text status (not dot color alone)', () => {
    const { getByText, getByTitle } = render(
      <JenkinsStageList
        stages={[
          stage({ name: 'Rust unit tests', status: 'SUCCESS' }),
          stage({ name: FLAKY_STAGE, status: 'IN_PROGRESS' }),
          stage({ name: 'Deploy preview', status: 'NOT_EXECUTED' }),
        ]}
      />
    )
    expect(getByText('Rust unit tests')).toBeInTheDocument()
    // The dot meaning is spelled out in the row's title attribute.
    expect(getByTitle(`${FLAKY_STAGE} : en cours`)).toBeInTheDocument()
    expect(getByTitle('Deploy preview : en attente')).toBeInTheDocument()
    expect(getByTitle('Rust unit tests : réussi')).toBeInTheDocument()
  })

  it('shows the retry counter and each attempt under the flaky stage', () => {
    const { getByText, getByTitle } = render(
      <JenkinsStageList
        stages={[stage({ name: FLAKY_STAGE, status: 'IN_PROGRESS' })]}
        attempts={[
          attempt({ attempt: 1, result: 'FAILURE' }),
          attempt({ attempt: 2, result: 'FAILURE' }),
          attempt({ attempt: 3, result: null, building: true, durationMs: 0 }),
        ]}
      />
    )
    // Headline retry counter on the stage row (pluralized).
    expect(getByText('3 essais')).toBeInTheDocument()
    // Each attempt is listed with its status spelled out in text.
    expect(getByTitle('Essai 1 : échec')).toBeInTheDocument()
    expect(getByTitle('Essai 3 : en cours')).toBeInTheDocument()
    expect(getByText('essai 2')).toBeInTheDocument()
    // …and links to its own console log.
    expect(
      getByTitle("Ouvrir le log de l'essai 2 sur Jenkins")
    ).toBeInTheDocument()
  })

  it('does not show the retry counter when there are no attempts', () => {
    const { queryByText } = render(
      <JenkinsStageList stages={[stage({ name: FLAKY_STAGE })]} />
    )
    expect(queryByText(/essai/)).not.toBeInTheDocument()
  })

  it('never attaches attempts to a stage other than the flaky one', () => {
    const { queryByText } = render(
      <JenkinsStageList
        stages={[stage({ name: 'Rust unit tests', status: 'FAILED' })]}
        attempts={[attempt({ attempt: 1 })]}
      />
    )
    expect(queryByText(/essai/)).not.toBeInTheDocument()
  })
})
