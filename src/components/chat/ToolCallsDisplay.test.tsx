import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { QuestionAnswer, ToolCall } from '@/types/chat'
import { ToolCallsDisplay } from './ToolCallsDisplay'

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: { expand_tool_calls_by_default: false } }),
}))

describe('ToolCallsDisplay', () => {
  const baseProps = {
    sessionId: 'session-1',
    isQuestionAnswered: () => false,
    getSubmittedAnswers: () => undefined,
  }

  it('renders native Codex request_user_input as an interactive question card', () => {
    const onQuestionAnswer =
      vi.fn<
        (
          toolCallId: string,
          answers: QuestionAnswer[],
          questions: unknown[]
        ) => void
      >()
    const toolCalls: ToolCall[] = [
      {
        id: 'codex-user-input-1',
        name: 'request_user_input',
        input: {
          questions: [
            {
              id: 'scope',
              header: 'Scope',
              question: 'Which scope?',
              options: [{ label: 'Backend' }, { label: 'Frontend' }],
            },
          ],
        },
      },
    ]

    render(
      <ToolCallsDisplay
        {...baseProps}
        toolCalls={toolCalls}
        onQuestionAnswer={onQuestionAnswer}
      />
    )

    expect(screen.getByText('Scope')).toBeInTheDocument()
    expect(screen.getByText('Which scope?')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Frontend'))
    fireEvent.click(screen.getByText('Answer'))

    expect(onQuestionAnswer).toHaveBeenCalledWith(
      'codex-user-input-1',
      [{ questionIndex: 0, selectedOptions: [1], customText: undefined }],
      [
        expect.objectContaining({
          header: 'Scope',
          question: 'Which scope?',
          options: [{ label: 'Backend' }, { label: 'Frontend' }],
        }),
      ]
    )
  })
})
