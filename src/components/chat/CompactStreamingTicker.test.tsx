import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { CompactStreamingTicker } from './CompactStreamingTicker'
import type { Question, QuestionAnswer } from '@/types/chat'

describe('CompactStreamingTicker', () => {
  const noopQuestionAnswer = (
    _toolCallId: string,
    _answers: QuestionAnswer[],
    _questions: Question[]
  ) => undefined

  const baseProps = {
    sessionId: 'session-1',
    contentBlocks: [],
    toolCalls: [],
    streamingContent: '',
    onQuestionAnswer: noopQuestionAnswer,
    onQuestionSkip: vi.fn(),
    onFileClick: vi.fn(),
    onEditedFileClick: vi.fn(),
    isQuestionAnswered: vi.fn(() => false),
    getSubmittedAnswers: vi.fn(() => undefined),
    areQuestionsSkipped: vi.fn(() => false),
  }

  it('keeps plan-mode tool batches compact while rendering the Codex plan', () => {
    render(
      <CompactStreamingTicker
        {...baseProps}
        contentBlocks={[
          { type: 'tool_use', tool_call_id: 'bash-1' },
          { type: 'tool_use', tool_call_id: 'bash-2' },
          { type: 'text', text: 'Repo inspected.' },
          { type: 'tool_use', tool_call_id: 'bash-3' },
          { type: 'tool_use', tool_call_id: 'plan-1' },
        ]}
        toolCalls={[
          {
            id: 'bash-1',
            name: 'Bash',
            input: { command: 'rtk cat CLAUDE.md' },
            output: 'ok',
          },
          {
            id: 'bash-2',
            name: 'Bash',
            input: { command: 'rtk rg compact src' },
            output: 'ok',
          },
          {
            id: 'bash-3',
            name: 'Bash',
            input: { command: 'rtk sed -n 1,80p file' },
          },
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              plan_preview: 'Plan:\n- Patch compact ticker\n- Add tests',
            },
          },
        ]}
      />
    )

    expect(screen.getByText('3 steps')).toBeVisible()
    expect(screen.getByText('Plan')).toBeVisible()
    expect(screen.getByText('Patch compact ticker')).toBeVisible()

    // Regression: CodexPlan used to force full StreamingMessage, exposing
    // multiple StackedGroup headers like "2 Bash" while the run was active.
    expect(screen.queryByText('2 Bash')).not.toBeInTheDocument()
    expect(screen.queryByText('3 Bash')).not.toBeInTheDocument()
  })
})
