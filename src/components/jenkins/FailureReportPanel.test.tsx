import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { JenkinsFailureReport } from '@/types/jenkins'

const mockQuery = vi.fn()
const mockSend = vi.fn()

vi.mock('@/services/jenkins', () => ({
  useJenkinsFailureReport: () => mockQuery(),
}))
vi.mock('@/components/mission-control/useSendFailureToAgent', () => ({
  useSendFailureToAgent: () => mockSend,
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))

import { FailureReportPanel } from './FailureReportPanel'

const project = { id: 'p1', name: 'Proj' } as never
const worktree = { id: 'w1', branch: 'feat', path: '/tmp/w' } as never

function report(partial: Partial<JenkinsFailureReport>): JenkinsFailureReport {
  return {
    pipelineNumber: 7139,
    stage: 'Elm tests',
    downstreamJob: 'elm-tests',
    downstreamNumber: 6377,
    consoleUrl: 'http://jenkins.example.internal/job/elm-tests/6377/console',
    failedTests: [],
    failedTestCount: 0,
    logExcerpt: '',
    ...partial,
  }
}

function renderPanel() {
  return render(
    <FailureReportPanel
      project={project}
      worktree={worktree}
      prId="4143"
      buildNumber={7139}
    />
  )
}

beforeEach(() => {
  mockQuery.mockReset()
  mockSend.mockReset()
  mockSend.mockResolvedValue(undefined)
})

describe('FailureReportPanel', () => {
  it('names the failing stage and downstream build in text, not just color', () => {
    mockQuery.mockReturnValue({
      data: report({ logExcerpt: 'boom' }),
      isLoading: false,
      error: null,
    })
    renderPanel()
    expect(screen.getByText('Elm tests')).toBeInTheDocument()
    expect(screen.getByText(/elm-tests #6377/)).toBeInTheDocument()
  })

  it('lists failing tests with their message', () => {
    mockQuery.mockReturnValue({
      data: report({
        failedTests: [
          {
            className: 'WidgetRepo',
            name: 'admin sees all widgets',
            message: 'Exceeded timeout of 5000 ms',
          },
        ],
        failedTestCount: 1,
      }),
      isLoading: false,
      error: null,
    })
    renderPanel()
    expect(screen.getByText('admin sees all widgets')).toBeInTheDocument()
    expect(screen.getByText(/Exceeded timeout/)).toBeInTheDocument()
    expect(screen.getByText(/1 test en échec/)).toBeInTheDocument()
  })

  it('says how many more failures stayed on Jenkins', () => {
    mockQuery.mockReturnValue({
      data: report({
        failedTests: [{ className: 'A', name: 'a', message: null }],
        failedTestCount: 12,
      }),
      isLoading: false,
      error: null,
    })
    renderPanel()
    expect(screen.getByText(/\+ 11 autres sur Jenkins/)).toBeInTheDocument()
  })

  it('shows the log tail first and reveals the rest on demand', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    mockQuery.mockReturnValue({
      data: report({ logExcerpt: lines.join('\n') }),
      isLoading: false,
      error: null,
    })
    renderPanel()
    expect(screen.getByText(/line 39/)).toBeInTheDocument()
    expect(screen.queryByText(/line 0\b/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/Afficher les 26 lignes précédentes/))
    expect(screen.getByText(/line 0/)).toBeInTheDocument()
  })

  it('hands the report to the agent on "Corriger avec Jean"', async () => {
    const data = report({ logExcerpt: 'boom' })
    mockQuery.mockReturnValue({ data, isLoading: false, error: null })
    renderPanel()

    // The handler is async (session lookup) — settle it before asserting.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Corriger avec Jean/ })
      )
    })
    expect(mockSend).toHaveBeenCalledWith({
      project,
      worktree,
      prId: '4143',
      report: data,
    })
  })

  it('disables the agent handoff when there is nothing to hand off', () => {
    mockQuery.mockReturnValue({
      data: report({}),
      isLoading: false,
      error: null,
    })
    renderPanel()
    expect(
      screen.getByRole('button', { name: /Corriger avec Jean/ })
    ).toBeDisabled()
    expect(
      screen.getByText(/ni test en échec ni log exploitable/)
    ).toBeVisible()
  })

  it('reports a loading and an error state instead of rendering nothing', () => {
    mockQuery.mockReturnValue({ data: null, isLoading: true, error: null })
    const { rerender } = renderPanel()
    expect(screen.getByText(/Analyse de l'échec/)).toBeInTheDocument()

    mockQuery.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error('Jenkins unreachable'),
    })
    rerender(
      <FailureReportPanel
        project={project}
        worktree={worktree}
        prId="4143"
        buildNumber={7139}
      />
    )
    expect(screen.getByText(/Diagnostic indisponible/)).toBeInTheDocument()
  })
})
