import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { JenkinsStageList } from './JenkinsStageList'
import type { JenkinsAttempt, JenkinsStage } from '@/types/jenkins'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

function stage(partial: Partial<JenkinsStage>): JenkinsStage {
  return { name: 'Stage', status: 'SUCCESS', durationMs: 1000, ...partial }
}

function attempt(partial: Partial<JenkinsAttempt>): JenkinsAttempt {
  return {
    attempt: 1,
    number: 1,
    result: 'FAILURE',
    building: false,
    durationMs: 1000,
    url: 'https://ci/job/integration-tests/1',
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
          stage({ name: 'Unit tests', status: 'SUCCESS' }),
          stage({ name: 'Integration tests', status: 'IN_PROGRESS' }),
          stage({ name: 'Deploy preview', status: 'NOT_EXECUTED' }),
        ]}
      />
    )
    expect(getByText('Unit tests')).toBeInTheDocument()
    // The dot meaning is spelled out in the row's title attribute.
    expect(getByTitle('Integration tests : en cours')).toBeInTheDocument()
    expect(getByTitle('Deploy preview : en attente')).toBeInTheDocument()
    expect(getByTitle('Unit tests : réussi')).toBeInTheDocument()
  })

  it('shows the retry counter and each attempt under Integration tests', () => {
    const { getByText, getByTitle } = render(
      <JenkinsStageList
        stages={[stage({ name: 'Integration tests', status: 'IN_PROGRESS' })]}
        attempts={[
          attempt({ attempt: 1, number: 6850, result: 'FAILURE' }),
          attempt({ attempt: 2, number: 6851, result: 'FAILURE' }),
          attempt({
            attempt: 3,
            number: 6852,
            result: null,
            building: true,
            durationMs: 0,
          }),
        ]}
      />
    )
    // Headline retry counter on the stage row (pluralized).
    expect(getByText('3 essais')).toBeInTheDocument()
    // Each attempt is listed with its build number, status spelled out in text.
    expect(getByTitle('Essai 1 (#6850) : échec')).toBeInTheDocument()
    expect(getByTitle('Essai 3 (#6852) : en cours')).toBeInTheDocument()
    expect(getByText('#6851')).toBeInTheDocument()
  })

  it('does not show the retry counter when there are no attempts', () => {
    const { queryByText } = render(
      <JenkinsStageList
        stages={[stage({ name: 'Integration tests', status: 'SUCCESS' })]}
      />
    )
    expect(queryByText(/essai/)).not.toBeInTheDocument()
  })
})
