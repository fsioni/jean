import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
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

  it('renders cancelled marker outside the compact activity card', () => {
    renderCompact([
      message('user-1', 'user', 100, 'check status'),
      message('assistant-1', 'assistant', 104, '', {
        cancelled: true,
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

    const compactTrigger = screen.getByRole('button', { name: /Bash/ })
    fireEvent.click(compactTrigger)

    const activityCard = compactTrigger.closest('.rounded-md.border')
    const cancelledMarker = screen.getByText('(cancelled)')

    expect(activityCard).not.toBeNull()
    expect(activityCard).not.toContainElement(cancelledMarker)
  })

  it('surfaces steered user prompts as separate visible rows', () => {
    renderCompact([
      message('user-1', 'user', 100, 'do the work'),
      message('assistant-1', 'assistant', 104, 'Done', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status' },
            output: 'clean',
          },
        ],
        content_blocks: [
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'user_input', text: 'also check the tests' },
          { type: 'text', text: 'Done' },
        ],
      }),
    ])

    // Steered prompt visible without expanding the collapsed activity row
    expect(screen.getByText('also check the tests')).toBeVisible()
    // Activity after the steer renders after the bubble (pure text segment)
    expect(screen.getByText('Done')).toBeVisible()
  })

  it('keeps steered prompts in chronological order around activity', () => {
    renderCompact([
      message('user-1', 'user', 100, 'hello'),
      message('assistant-1', 'assistant', 104, 'All received', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status' },
            output: 'clean',
          },
        ],
        content_blocks: [
          { type: 'user_input', text: 'whatsup' },
          { type: 'user_input', text: 'is it?' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'text', text: 'All received' },
        ],
      }),
    ])

    const whatsup = screen.getByText('whatsup')
    const isIt = screen.getByText('is it?')
    const activity = screen.getAllByText('All received')[0]

    // Consecutive steered prompts render inside ONE connected group card
    expect(whatsup.closest('.divide-y')).toBe(isIt.closest('.divide-y'))
    expect(whatsup.closest('.divide-y')).not.toBeNull()

    // Steered prompts come BEFORE the activity that followed them
    expect(
      whatsup.compareDocumentPosition(isIt) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      activity &&
        isIt.compareDocumentPosition(activity) &
          Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
