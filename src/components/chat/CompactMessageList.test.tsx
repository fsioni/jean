import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { CompactMessageList } from './CompactMessageList'
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
  content: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    session_id: 'session-1',
    role,
    content,
    timestamp,
    tool_calls: [],
    content_blocks: [],
    ...overrides,
  }
}

function renderCompact(messages: ChatMessage[]) {
  return render(
    <CompactMessageList
      messages={messages}
      scrollContainerRef={createRef<HTMLDivElement>()}
      totalMessages={messages.length}
      lastPlanMessageIndex={-1}
      sessionId="session-1"
      worktreePath="/tmp/worktree"
      approveShortcut="Cmd+Enter"
      isSending={false}
      onPlanApproval={vi.fn()}
      onQuestionAnswer={noopQuestionAnswer}
      onQuestionSkip={vi.fn()}
      onFileClick={vi.fn()}
      onEditedFileClick={vi.fn()}
      onFixFinding={noopFixFinding}
      onFixAllFindings={noopFixAllFindings}
      isQuestionAnswered={vi.fn(() => false)}
      getSubmittedAnswers={vi.fn(() => undefined)}
      areQuestionsSkipped={vi.fn(() => false)}
      isFindingFixed={vi.fn(() => false)}
    />
  )
}

describe('CompactMessageList', () => {
  it('renders a single pure text assistant response once instead of as activity plus text', () => {
    renderCompact([
      message('user-1', 'user', 100, 'hello'),
      message('assistant-1', 'assistant', 104, 'Hello!', {
        content_blocks: [{ type: 'text', text: 'Hello!' }],
      }),
    ])

    expect(screen.getAllByText('Hello!')).toHaveLength(1)
    expect(screen.queryByText('1 msg')).not.toBeInTheDocument()
  })

  it('still compacts assistant messages that contain actual tool activity', () => {
    renderCompact([
      message('user-1', 'user', 100, 'check status'),
      message('assistant-1', 'assistant', 104, '', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status --short' },
            output: 'clean',
          },
        ],
        content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
      }),
    ])

    expect(screen.getByText('Bash')).toBeVisible()
    expect(screen.getByText('1 step')).toBeVisible()
  })
})
