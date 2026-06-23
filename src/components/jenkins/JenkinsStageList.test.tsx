import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { JenkinsStageList } from './JenkinsStageList'
import type { JenkinsStage } from '@/types/jenkins'

function stage(partial: Partial<JenkinsStage>): JenkinsStage {
  return { name: 'Stage', status: 'SUCCESS', durationMs: 1000, ...partial }
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
})
