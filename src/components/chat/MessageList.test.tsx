import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { MessageList } from './MessageList'
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'

const noopQuestionAnswer = (
  _toolCallId: string,
  _answers: QuestionAnswer[],
  _questions: Question[]
) => undefined

const noopFixFinding = async (_finding: ReviewFinding, _suggestion?: string) =>
  undefined

const noopFixAllFindings = async (
  _findings: { finding: ReviewFinding; suggestion?: string }[]
) => undefined

function message(
  id: string,
  role: ChatMessage['role'],
  timestamp: number,
  content: string
): ChatMessage {
  return {
    id,
    session_id: 'session-1',
    role,
    content,
    timestamp,
    tool_calls: [],
    content_blocks: [],
  }
}

const baseProps = {
  totalMessages: 2,
  lastPlanMessageIndex: -1,
  sessionId: 'session-1',
  worktreePath: '/tmp/worktree',
  approveShortcut: 'Cmd+Enter',
  isSending: false,
  onPlanApproval: vi.fn(),
  onQuestionAnswer: noopQuestionAnswer,
  onQuestionSkip: vi.fn(),
  onFileClick: vi.fn(),
  onFixFinding: noopFixFinding,
  onFixAllFindings: noopFixAllFindings,
  isQuestionAnswered: vi.fn(() => false),
  getSubmittedAnswers: vi.fn(() => undefined),
  areQuestionsSkipped: vi.fn(() => false),
  isFindingFixed: vi.fn(() => false),
}

describe('MessageList durations', () => {
  it('shows stored completed duration on the latest assistant message', () => {
    render(
      <MessageList
        {...baseProps}
        messages={[
          message('user-1', 'user', 100, 'Prompt'),
          message('assistant-1', 'assistant', 101, 'Reply'),
        ]}
        completedDurationMs={145_000}
      />
    )

    expect(screen.getByText('02:25')).toBeVisible()
  })

  it('falls back to persisted user-to-assistant timestamp delta', () => {
    render(
      <MessageList
        {...baseProps}
        messages={[
          message('user-1', 'user', 100, 'Prompt'),
          message('assistant-1', 'assistant', 123, 'Reply'),
        ]}
      />
    )

    expect(screen.getByText('23s')).toBeVisible()
  })
})
