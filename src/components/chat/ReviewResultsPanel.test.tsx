import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { useChatStore } from '@/store/chat-store'
import { ReviewResultsPanel } from './ReviewResultsPanel'
import type { ReviewResponse } from '@/types/projects'

let isMobile = false

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

describe('ReviewResultsPanel', () => {
  beforeEach(() => {
    isMobile = false
    Element.prototype.scrollIntoView = vi.fn()
    useChatStore.setState({
      reviewResults: {},
      fixedReviewFindings: {},
      reviewSidebarVisible: false,
    })
  })

  it('shows review metadata and failure scenario for structured findings', () => {
    const reviewResults: ReviewResponse = {
      summary: 'One high-confidence correctness issue found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          category: 'correctness',
          confidence: 'high',
          blocking: true,
          introduced_by_diff: true,
          file: 'src/App.tsx',
          line: 42,
          title: 'Null access after guard removal',
          description:
            'The new code dereferences value after removing a guard.',
          failure_scenario: 'When value is null, rendering throws.',
          suggestion: 'Restore the null guard before dereferencing value.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" />)

    expect(screen.getByText('Correctness')).toBeInTheDocument()
    expect(screen.getByText('High confidence')).toBeInTheDocument()
    expect(screen.getByText('Blocking')).toBeInTheDocument()
    expect(screen.getByText('Introduced by diff')).toBeInTheDocument()
    expect(screen.getByText('Failure Scenario')).toBeInTheDocument()
    expect(
      screen.getByText('When value is null, rendering throws.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/praise/i)).not.toBeInTheDocument()
  })

  it('shows a running indicator while the review is in progress', () => {
    render(<ReviewResultsPanel sessionId="session-1" isReviewing />)

    expect(screen.getByText('Review running...')).toBeInTheDocument()
    expect(screen.queryByText('No review results')).not.toBeInTheDocument()
  })

  it('switches between grouped reviews using backend and model labels', async () => {
    useChatStore.getState().setReviewResults('session-1', {
      reviews: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          result: {
            summary: 'Codex review',
            approval_status: 'changes_requested',
            findings: [
              {
                severity: 'warning',
                file: 'src/codex.ts',
                title: 'Codex finding',
                description: 'Found by Codex.',
              },
            ],
          },
        },
        {
          backend: 'claude',
          model: 'claude-fable-5',
          result: {
            summary: 'Claude review',
            approval_status: 'approved',
            findings: [
              {
                severity: 'suggestion',
                file: 'src/claude.ts',
                title: 'Claude finding',
                description: 'Found by Claude.',
              },
            ],
          },
        },
      ],
    } as never)

    render(<ReviewResultsPanel sessionId="session-1" />)

    expect(screen.getAllByText('Codex finding')).toHaveLength(2)
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(
      screen.getByRole('option', { name: 'Claude · claude-fable-5' })
    )
    expect(screen.getAllByText('Claude finding')).toHaveLength(2)
  })

  it('falls back to the first available review after changing sessions', async () => {
    useChatStore.getState().setReviewResults('session-1', {
      reviews: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          result: {
            summary: 'Codex review',
            approval_status: 'approved',
            findings: [],
          },
        },
        {
          backend: 'claude',
          model: 'claude-fable-5',
          result: {
            summary: 'Claude review',
            approval_status: 'approved',
            findings: [],
          },
        },
      ],
    } as never)
    useChatStore.getState().setReviewResults('session-2', {
      reviews: [
        {
          backend: 'opencode',
          model: 'big-pickle',
          result: {
            summary: 'OpenCode review for the new session',
            approval_status: 'approved',
            findings: [
              {
                severity: 'suggestion',
                file: 'src/new-session.ts',
                title: 'New session finding',
                description: 'Found in the newly selected session.',
              },
            ],
          },
        },
      ],
    } as never)

    const { rerender } = render(
      <ReviewResultsPanel sessionId="session-1" />
    )
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(
      screen.getByRole('option', { name: 'Claude · claude-fable-5' })
    )

    rerender(<ReviewResultsPanel sessionId="session-2" />)

    expect(screen.getAllByText('New session finding')).toHaveLength(2)
  })

  it('shows a loading status for a grouped review that is still running', () => {
    useChatStore.getState().setReviewResults('session-1', {
      reviews: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          status: 'running',
        },
        {
          backend: 'claude',
          model: 'claude-fable-5',
          status: 'running',
        },
      ],
    } as never)

    render(<ReviewResultsPanel sessionId="session-1" isReviewing />)

    expect(screen.getByRole('combobox')).toHaveTextContent(
      /Codex · gpt-5\.6-sol.*Running/
    )
  })

  it('does not show a close button for code review results', () => {
    const reviewResults: ReviewResponse = {
      summary: 'No findings.',
      approval_status: 'approved',
      findings: [],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    render(<ReviewResultsPanel sessionId="session-1" />)

    expect(
      screen.queryByRole('button', { name: 'Close' })
    ).not.toBeInTheDocument()
  })

  it('uses a vertical master-detail layout on mobile', () => {
    isMobile = true
    const reviewResults: ReviewResponse = {
      summary: 'One issue found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/components/chat/hooks/useGitOperations.ts',
          title: 'Review completion event can be missed',
          description: 'The frontend can miss a fast completion event.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    const { container } = render(<ReviewResultsPanel sessionId="session-1" />)

    expect(
      container.querySelector('[data-panel-group-direction="vertical"]')
    ).toBeInTheDocument()
  })

  it('scrolls the finding details back to the top when selecting another finding', async () => {
    const reviewResults: ReviewResponse = {
      summary: 'Two issues found.',
      approval_status: 'changes_requested',
      findings: [
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'First finding',
          description: 'First finding details.',
        },
        {
          severity: 'warning',
          file: 'src/App.tsx',
          title: 'Second finding',
          description: 'Second finding details.',
        },
      ],
    }

    useChatStore.getState().setReviewResults('session-1', reviewResults)

    const { container } = render(<ReviewResultsPanel sessionId="session-1" />)
    const detailScrollViewport = container.querySelectorAll(
      '[data-slot="scroll-area-viewport"]'
    )[1]
    expect(detailScrollViewport).toBeInstanceOf(HTMLElement)
    const detailScrollElement = detailScrollViewport as HTMLElement

    detailScrollElement.scrollTop = 240

    await userEvent.click(
      screen.getByRole('button', { name: /second finding/i })
    )

    expect(detailScrollElement.scrollTop).toBe(0)
  })
})
