import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { ChevronRight, Loader2, Activity, Brain } from 'lucide-react'
import { Markdown } from '@/components/ui/markdown'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type {
  ChatMessage,
  ContentBlock,
  Question,
  QuestionAnswer,
  ReviewFinding,
  ToolCall,
} from '@/types/chat'
import {
  hasQuestionAnswerOutput,
  isAskUserQuestion,
  isPlanToolCall,
} from '@/types/chat'
import { MessageItem } from './MessageItem'
import { AskUserQuestion } from './AskUserQuestion'
import { buildTimeline } from './tool-call-utils'
import {
  TOOL_CALL_ROW_CLASS,
  TOOL_CALL_DETAIL_PILL_CLASS,
} from './ToolCallInline'
import type { VirtualizedMessageListHandle } from './VirtualizedMessageList'
import type { FileEdit } from './FileEditsDiffModal'

const SCROLL_THRESHOLD = 300

interface CompactMessageListProps {
  messages: ChatMessage[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  totalMessages: number
  lastPlanMessageIndex: number
  sessionId: string
  worktreePath: string
  approveShortcut: string
  approveShortcutYolo?: string
  approveShortcutClearContext?: string
  approveShortcutClearContextBuild?: string
  approveButtonRef?: React.RefObject<HTMLButtonElement | null>
  isSending: boolean
  onPlanApproval: (messageId: string) => void
  onPlanApprovalYolo?: (messageId: string) => void
  onClearContextApproval?: (messageId: string) => void
  onClearContextApprovalBuild?: (messageId: string) => void
  onWorktreeBuildApproval?: (messageId: string) => void
  onWorktreeYoloApproval?: (messageId: string) => void
  onQuestionAnswer: (
    toolCallId: string,
    answers: QuestionAnswer[],
    questions: Question[]
  ) => void
  onQuestionSkip: (toolCallId: string) => void
  onFileClick: (path: string) => void
  onEditedFileClick: (path: string, edits: FileEdit[]) => void
  onFixFinding: (finding: ReviewFinding, suggestion?: string) => Promise<void>
  onFixAllFindings: (
    findings: { finding: ReviewFinding; suggestion?: string }[]
  ) => Promise<void>
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined
  areQuestionsSkipped: (sessionId: string) => boolean
  isFindingFixed: (sessionId: string, key: string) => boolean
  onCopyToInput?: (message: ChatMessage) => void
  hideApproveButtons?: boolean
  shouldScrollToBottom?: boolean
  onScrollToBottomHandled?: () => void
  completedDurationMs?: number | null
  hasOlderOnDisk?: boolean
  isLoadingOlder?: boolean
  onLoadOlderRuns?: () => void
  loadedRunStartIndex?: number
  hiddenPromptCount?: number
  onShowHiddenPrompts?: () => void
}

type RenderItem =
  | { kind: 'message'; message: ChatMessage; globalIndex: number }
  | {
      kind: 'compact'
      messages: { message: ChatMessage; globalIndex: number }[]
      key: string
      latestText: string | null
    }
  | { kind: 'question'; message: ChatMessage; globalIndex: number }

/**
 * Returns true if an assistant message should always render in full
 * (contains a plan tool call) under compact mode.
 */
function messageContainsPlan(message: ChatMessage): boolean {
  return Boolean(message.tool_calls?.some(isPlanToolCall))
}

function messageContainsQuestion(message: ChatMessage): boolean {
  return Boolean(message.tool_calls?.some(isAskUserQuestion))
}

const RECAP_HEADING_RE = /^##\s+Recap\s*$/im

/**
 * If `text` contains a `## Recap` markdown heading, returns the slice from
 * that heading to the next H1/H2 (or end of string). Otherwise returns null.
 * The backend instructs the assistant (via system prompt) to terminate every
 * multi-step turn with this section, so the compact view can surface a short
 * summary instead of the full tool-stripped prose replay.
 */
function extractRecapSection(text: string): string | null {
  const match = RECAP_HEADING_RE.exec(text)
  if (!match) return null
  const start = match.index
  const afterHeading = start + match[0].length
  const rest = text.slice(afterHeading)
  const nextHeading = /^#{1,2}\s+/m.exec(rest)
  const end = nextHeading ? afterHeading + nextHeading.index : text.length
  return text.slice(start, end).trim() || null
}

/**
 * Returns the latest assistant prose text in a compact group as plain text.
 * Walks newest → oldest and returns the first non-empty result. If the latest
 * message contains a `## Recap` section, only that section is returned so the
 * compact view surfaces the wrap-up instead of replaying the whole turn.
 */
function findLatestAssistantText(
  group: { message: ChatMessage }[]
): string | null {
  for (let g = group.length - 1; g >= 0; g--) {
    const message = group[g]?.message
    if (!message || message.role !== 'assistant') continue

    const blocks = message.content_blocks ?? []
    const texts: string[] = []
    for (const block of blocks) {
      if (block?.type === 'text' && block.text.trim()) {
        texts.push(block.text)
      }
    }
    if (texts.length === 0 && message.content?.trim()) {
      texts.push(message.content)
    }
    if (texts.length === 0) continue

    const combined = texts.join('\n\n')
    if (!combined.trim()) continue
    return extractRecapSection(combined) ?? combined
  }
  return null
}

/**
 * Trims the `## Recap` section (and everything after it up to the next H1/H2)
 * from a markdown string. Returns the original string unchanged when no recap
 * heading is present.
 */
function stripRecapFromText(text: string): string {
  const match = RECAP_HEADING_RE.exec(text)
  if (!match) return text
  const start = match.index
  const afterHeading = start + match[0].length
  const rest = text.slice(afterHeading)
  const nextHeading = /^#{1,2}\s+/m.exec(rest)
  const before = text.slice(0, start).trimEnd()
  const after = nextHeading ? text.slice(afterHeading + nextHeading.index) : ''
  return after ? `${before}\n\n${after}`.trim() : before
}

/**
 * Returns a clone of `message` with the `## Recap` section removed from any
 * text content blocks. Used so the latest assistant message doesn't duplicate
 * the recap that already renders in the `latestText` block under the activity
 * row.
 */
function stripRecapFromMessage(message: ChatMessage): ChatMessage {
  const blocks = message.content_blocks
  let changed = false
  let newBlocks: ContentBlock[] | undefined
  if (blocks && blocks.length > 0) {
    newBlocks = []
    for (const block of blocks) {
      if (block?.type === 'text' && RECAP_HEADING_RE.test(block.text)) {
        const stripped = stripRecapFromText(block.text)
        changed = true
        if (stripped) newBlocks.push({ ...block, text: stripped })
      } else {
        newBlocks.push(block)
      }
    }
  }
  let newContent = message.content
  if (newContent && RECAP_HEADING_RE.test(newContent)) {
    const stripped = stripRecapFromText(newContent)
    if (stripped !== newContent) {
      newContent = stripped
      changed = true
    }
  }
  if (!changed) return message
  return {
    ...message,
    ...(newBlocks ? { content_blocks: newBlocks } : {}),
    ...(newContent !== message.content ? { content: newContent } : {}),
  }
}

/**
 * Returns a clone of `message` with all AskUserQuestion tool calls / blocks
 * removed so {@link MessageItem} can render the surrounding timeline without
 * duplicating the question UI we render separately.
 */
function stripQuestionsFromMessage(message: ChatMessage): ChatMessage {
  const questionIds = new Set(
    (message.tool_calls ?? [])
      .filter(tc => isAskUserQuestion(tc))
      .map(tc => tc.id)
  )
  if (questionIds.size === 0) return message
  return {
    ...message,
    tool_calls: (message.tool_calls ?? []).filter(
      tc => !questionIds.has(tc.id)
    ),
    content_blocks: message.content_blocks
      ? message.content_blocks.filter(
          b => b.type !== 'tool_use' || !questionIds.has(b.tool_call_id)
        )
      : undefined,
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function truncatePath(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  if (oneLine.includes('/')) return `…${oneLine.slice(-(max - 1))}`
  return `${oneLine.slice(0, max - 1)}…`
}

function summarizeToolCall(tc: ToolCall): { label: string; detail?: string } {
  const input = (tc.input ?? {}) as Record<string, unknown>
  const filePath =
    typeof input.file_path === 'string' ? input.file_path : undefined
  const path = typeof input.path === 'string' ? input.path : undefined
  const command = typeof input.command === 'string' ? input.command : undefined
  const url = typeof input.url === 'string' ? input.url : undefined
  const pattern = typeof input.pattern === 'string' ? input.pattern : undefined
  const description =
    typeof input.description === 'string' ? input.description : undefined

  const pathDetail = filePath ?? path
  if (pathDetail) {
    return { label: tc.name, detail: truncatePath(pathDetail, 80) }
  }
  const detail = command ?? url ?? pattern ?? description ?? undefined
  return {
    label: tc.name,
    detail: detail ? truncate(detail, 80) : undefined,
  }
}

/**
 * Walks the latest message in a compact group and returns a one-line summary
 * of the most recent meaningful activity (tool call name, last text snippet,
 * or "Thinking…").
 */
function summarizeGroup(
  group: { message: ChatMessage; globalIndex: number }[]
): { label: string; detail?: string; isThinking: boolean } {
  for (let g = group.length - 1; g >= 0; g--) {
    const message = group[g]?.message
    if (!message) continue
    const blocks: ContentBlock[] = message.content_blocks ?? []
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]
      if (!block) continue
      if (block.type === 'tool_use') {
        const tc = message.tool_calls?.find(t => t.id === block.tool_call_id)
        if (tc) {
          const summary = summarizeToolCall(tc)
          return { ...summary, isThinking: false }
        }
        continue
      }
      if (block.type === 'thinking') {
        return { label: 'Thinking…', isThinking: true }
      }
      if (block.type === 'text' && block.text.trim()) {
        return { label: truncate(block.text.trim(), 120), isThinking: false }
      }
    }

    const lastTool = message.tool_calls?.[message.tool_calls.length - 1]
    if (lastTool) {
      const summary = summarizeToolCall(lastTool)
      return { ...summary, isThinking: false }
    }

    if (message.content?.trim()) {
      return {
        label: truncate(message.content.trim(), 120),
        isThinking: false,
      }
    }
  }
  return { label: 'Activity', isThinking: false }
}

function countSteps(group: { message: ChatMessage }[]): number {
  let total = 0
  for (const { message } of group) {
    total += message.tool_calls?.length ?? 0
  }
  return total
}

interface CompactActivityRowProps {
  group: { message: ChatMessage; globalIndex: number }[]
  total: number
  renderMessage: (
    item: { message: ChatMessage; globalIndex: number },
    extra: { hasFollowUpMessage: boolean; durationMs: number | null }
  ) => React.ReactNode
  hasFollowUpFor: (globalIndex: number) => boolean
  durationFor: (globalIndex: number, message: ChatMessage) => number | null
  /** When true, the recap section is rendered separately under the row, so
   * strip it from the latest assistant message inside the expanded body to
   * avoid duplicating the recap. */
  recapShownExternally?: boolean
}

function CompactActivityRow({
  group,
  total,
  renderMessage,
  hasFollowUpFor,
  durationFor,
  recapShownExternally,
}: CompactActivityRowProps) {
  const [isOpen, setIsOpen] = useState(false)
  const summary = useMemo(() => summarizeGroup(group), [group])
  const stepCount = useMemo(() => countSteps(group), [group])
  const messageCount = group.length

  const renderGroup = useMemo(() => {
    if (!recapShownExternally) return group
    let stripped = false
    return group
      .slice()
      .reverse()
      .map(item => {
        if (stripped || item.message.role !== 'assistant') return item
        stripped = true
        return { ...item, message: stripRecapFromMessage(item.message) }
      })
      .reverse()
  }, [group, recapShownExternally])

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className="min-w-0 pb-4"
    >
      <div
        className={
          'rounded-md border border-border/50 bg-muted/30 min-w-0' +
          (isOpen ? ' bg-muted/50' : '')
        }
      >
        <CollapsibleTrigger className={TOOL_CALL_ROW_CLASS}>
          {summary.isThinking ? (
            <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <Activity className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
          <span className="font-medium shrink-0 flex-none whitespace-nowrap">
            {summary.label}
          </span>
          {summary.detail && (
            <code className={TOOL_CALL_DETAIL_PILL_CLASS}>
              {summary.detail}
            </code>
          )}
          <span className="ml-auto flex items-center gap-2 shrink-0">
            <span className="hidden sm:inline text-muted-foreground/70 tabular-nums">
              {stepCount > 0
                ? `${stepCount} step${stepCount === 1 ? '' : 's'}`
                : `${messageCount} msg${messageCount === 1 ? '' : 's'}`}
            </span>
            <ChevronRight
              className={
                'h-3.5 w-3.5 transition-transform duration-200' +
                (isOpen ? ' rotate-90' : '')
              }
            />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/50 p-3 space-y-4">
            {renderGroup.map(item => (
              <div key={item.message.id}>
                {renderMessage(item, {
                  hasFollowUpMessage: hasFollowUpFor(item.globalIndex),
                  durationMs: durationFor(item.globalIndex, item.message),
                })}
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </div>
      <span aria-hidden className="sr-only">
        Total: {total}
      </span>
    </Collapsible>
  )
}

interface CompactQuestionMessageProps {
  message: ChatMessage
  globalIndex: number
  totalMessages: number
  hasFollowUpMessage: boolean
  durationMs: number | null
  sessionId: string
  onQuestionAnswer: (
    toolCallId: string,
    answers: QuestionAnswer[],
    questions: Question[]
  ) => void
  onQuestionSkip: (toolCallId: string) => void
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined
  areQuestionsSkipped: (sessionId: string) => boolean
  renderMessage: (
    item: { message: ChatMessage; globalIndex: number },
    extra: { hasFollowUpMessage: boolean; durationMs: number | null }
  ) => React.ReactNode
  hasFollowUpFor: (globalIndex: number) => boolean
  durationFor: (globalIndex: number, message: ChatMessage) => number | null
}

/**
 * Renders an assistant message that asks the user a question:
 *  - The preceding tool calls / text are folded into a {@link CompactActivityRow}
 *    so only a single ticker line is visible by default.
 *  - The {@link AskUserQuestion}(s) themselves render full so the user can
 *    answer or skip.
 */
function CompactQuestionMessage({
  message,
  globalIndex,
  totalMessages: _totalMessages,
  hasFollowUpMessage,
  durationMs,
  sessionId,
  onQuestionAnswer,
  onQuestionSkip,
  isQuestionAnswered,
  getSubmittedAnswers,
  areQuestionsSkipped,
  renderMessage,
  hasFollowUpFor,
  durationFor,
}: CompactQuestionMessageProps) {
  const stripped = useMemo(() => stripQuestionsFromMessage(message), [message])

  const questionItems = useMemo(() => {
    const blocks = message.content_blocks ?? []
    const timeline = buildTimeline(blocks, message.tool_calls ?? [])
    return timeline.flatMap(item =>
      item.type === 'askUserQuestion' ? [item] : []
    )
  }, [message])

  const hasNonQuestionContent = useMemo(() => {
    if (stripped.tool_calls && stripped.tool_calls.length > 0) return true
    if (
      stripped.content_blocks &&
      stripped.content_blocks.some(
        b => b.type !== 'text' || (b.type === 'text' && b.text.trim() !== '')
      )
    ) {
      return true
    }
    return Boolean(stripped.content && stripped.content.trim() !== '')
  }, [stripped])

  return (
    <>
      {hasNonQuestionContent && (
        <CompactActivityRow
          group={[{ message: stripped, globalIndex }]}
          total={1}
          renderMessage={renderMessage}
          hasFollowUpFor={hasFollowUpFor}
          durationFor={durationFor}
        />
      )}
      {questionItems.map(item => {
        const isAnswered =
          hasFollowUpMessage ||
          isQuestionAnswered(sessionId, item.tool.id) ||
          hasQuestionAnswerOutput(item.tool.output)
        const rawInput = item.tool.input as {
          questions: (Question & { multiple?: boolean })[]
        }
        const normalizedQuestions = rawInput.questions.map(q => ({
          ...q,
          multiSelect: q.multiSelect ?? q.multiple === true,
        }))
        return (
          <AskUserQuestion
            key={item.key}
            toolCallId={item.tool.id}
            questions={normalizedQuestions}
            introText={item.introText}
            hasFollowUpMessage={
              hasFollowUpMessage || hasQuestionAnswerOutput(item.tool.output)
            }
            isSkipped={areQuestionsSkipped(sessionId)}
            onSubmit={(toolCallId, answers) =>
              onQuestionAnswer(toolCallId, answers, normalizedQuestions)
            }
            onSkip={onQuestionSkip}
            readOnly={isAnswered}
            submittedAnswers={
              isAnswered
                ? getSubmittedAnswers(sessionId, item.tool.id)
                : undefined
            }
            toolOutput={item.tool.output ?? undefined}
          />
        )
      })}
      <span aria-hidden className="sr-only">
        {durationMs ? `Duration ${durationMs}ms` : ''}
      </span>
    </>
  )
}

/**
 * Compact replacement for {@link import('./VirtualizedMessageList').VirtualizedMessageList}
 * used when the `compact_chat_view_enabled` preference is on.
 *
 * Behaviour:
 *  - User messages render in full.
 *  - Assistant messages with plan tool calls render in full so PlanDisplay /
 *    ExitPlanModeButton remain interactive.
 *  - Assistant messages containing an AskUserQuestion fold their preceding
 *    tool calls into a single ticker line and render the question full.
 *  - The last assistant message (final conclusion) renders in full.
 *  - Other intermediate assistant messages collapse into a single
 *    {@link CompactActivityRow} that shows the latest tool / text and expands
 *    on click to reveal the buffered messages.
 */
export const CompactMessageList = memo(
  forwardRef<VirtualizedMessageListHandle, CompactMessageListProps>(
    function CompactMessageList(
      {
        messages,
        scrollContainerRef,
        totalMessages,
        lastPlanMessageIndex,
        sessionId,
        worktreePath,
        approveShortcut,
        approveShortcutYolo,
        approveShortcutClearContext,
        approveShortcutClearContextBuild,
        approveButtonRef,
        isSending,
        onPlanApproval,
        onPlanApprovalYolo,
        onClearContextApproval,
        onClearContextApprovalBuild,
        onWorktreeBuildApproval,
        onWorktreeYoloApproval,
        onQuestionAnswer,
        onQuestionSkip,
        onFileClick,
        onEditedFileClick,
        onFixFinding,
        onFixAllFindings,
        isQuestionAnswered,
        getSubmittedAnswers,
        areQuestionsSkipped,
        isFindingFixed,
        onCopyToInput,
        hideApproveButtons,
        shouldScrollToBottom,
        onScrollToBottomHandled,
        completedDurationMs,
        hasOlderOnDisk = false,
        isLoadingOlder = false,
        onLoadOlderRuns,
        loadedRunStartIndex = 0,
        hiddenPromptCount = 0,
        onShowHiddenPrompts,
      },
      ref
    ) {
      const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
      const pendingPrependScrollHeightRef = useRef<number | null>(null)
      const pendingPrependMessagesLengthRef = useRef<number | null>(null)

      const lastIndex = messages.length - 1
      const hasHiddenPrompts = hiddenPromptCount > 0 && !!onShowHiddenPrompts

      const hasFollowUpMap = useMemo(() => {
        const map = new Map<number, boolean>()
        let foundUserMessage = false
        for (let i = messages.length - 1; i >= 0; i--) {
          map.set(i, foundUserMessage)
          if (messages[i]?.role === 'user') {
            foundUserMessage = true
          }
        }
        return map
      }, [messages])

      const hasFollowUpFor = useCallback(
        (globalIndex: number) => hasFollowUpMap.get(globalIndex) ?? false,
        [hasFollowUpMap]
      )

      const latestRunHasPlan = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (!m) continue
          if (m.role === 'user') return false
          if (m.tool_calls?.some(isPlanToolCall)) return true
        }
        return false
      }, [messages])

      const durationFor = useCallback(
        (globalIndex: number, message: ChatMessage): number | null => {
          if (message.role !== 'assistant') return null
          if (globalIndex === lastIndex && completedDurationMs) {
            return completedDurationMs
          }
          if (globalIndex > 0) {
            const prev = messages[globalIndex - 1]
            if (prev?.role === 'user') {
              const deltaSecs = message.timestamp - prev.timestamp
              if (deltaSecs > 0 && deltaSecs < 3600) return deltaSecs * 1000
            }
          }
          return null
        },
        [messages, lastIndex, completedDurationMs]
      )

      // Group messages into render items. Anything that should always render
      // full flushes the in-flight compact buffer.
      const renderItems = useMemo<RenderItem[]>(() => {
        const items: RenderItem[] = []
        let buffer: { message: ChatMessage; globalIndex: number }[] = []

        const flush = () => {
          if (buffer.length === 0) return
          const first = buffer[0]
          const last = buffer[buffer.length - 1]
          if (!first || !last) {
            buffer = []
            return
          }
          const compactKey =
            buffer.length === 1
              ? `compact-${first.message.id}`
              : `compact-${first.message.id}-${last.message.id}`
          items.push({
            kind: 'compact',
            messages: buffer,
            key: compactKey,
            latestText: findLatestAssistantText(buffer),
          })
          buffer = []
        }

        messages.forEach((message, globalIndex) => {
          if (message.role === 'user') {
            flush()
            items.push({ kind: 'message', message, globalIndex })
            return
          }

          if (messageContainsPlan(message)) {
            const isResolvedPlan =
              Boolean(message.plan_approved) &&
              (hasFollowUpMap.get(globalIndex) ?? false)
            if (!isResolvedPlan) {
              flush()
              items.push({ kind: 'message', message, globalIndex })
              return
            }
            buffer.push({ message, globalIndex })
            return
          }

          if (messageContainsQuestion(message)) {
            flush()
            items.push({ kind: 'question', message, globalIndex })
            return
          }

          buffer.push({ message, globalIndex })
        })

        flush()
        return items
      }, [messages, lastIndex, hasFollowUpMap])

      const renderMessageItem = useCallback(
        (
          item: { message: ChatMessage; globalIndex: number },
          extra: {
            hasFollowUpMessage: boolean
            durationMs: number | null
          }
        ) => (
          <MessageItem
            message={item.message}
            messageIndex={item.globalIndex}
            totalMessages={totalMessages}
            lastPlanMessageIndex={lastPlanMessageIndex}
            hasFollowUpMessage={extra.hasFollowUpMessage}
            sessionId={sessionId}
            worktreePath={worktreePath}
            approveShortcut={approveShortcut}
            approveShortcutYolo={approveShortcutYolo}
            approveShortcutClearContext={approveShortcutClearContext}
            approveShortcutClearContextBuild={approveShortcutClearContextBuild}
            approveButtonRef={
              item.globalIndex === lastPlanMessageIndex
                ? approveButtonRef
                : undefined
            }
            isSending={isSending}
            onPlanApproval={onPlanApproval}
            onPlanApprovalYolo={onPlanApprovalYolo}
            onClearContextApproval={onClearContextApproval}
            onClearContextApprovalBuild={onClearContextApprovalBuild}
            onWorktreeBuildApproval={onWorktreeBuildApproval}
            onWorktreeYoloApproval={onWorktreeYoloApproval}
            onQuestionAnswer={onQuestionAnswer}
            onQuestionSkip={onQuestionSkip}
            onFileClick={onFileClick}
            onEditedFileClick={onEditedFileClick}
            onFixFinding={onFixFinding}
            onFixAllFindings={onFixAllFindings}
            isQuestionAnswered={isQuestionAnswered}
            getSubmittedAnswers={getSubmittedAnswers}
            areQuestionsSkipped={areQuestionsSkipped}
            isFindingFixed={isFindingFixed}
            onCopyToInput={onCopyToInput}
            hideApproveButtons={hideApproveButtons}
            durationMs={extra.durationMs}
          />
        ),
        [
          totalMessages,
          lastPlanMessageIndex,
          sessionId,
          worktreePath,
          approveShortcut,
          approveShortcutYolo,
          approveShortcutClearContext,
          approveShortcutClearContextBuild,
          approveButtonRef,
          isSending,
          onPlanApproval,
          onPlanApprovalYolo,
          onClearContextApproval,
          onClearContextApprovalBuild,
          onWorktreeBuildApproval,
          onWorktreeYoloApproval,
          onQuestionAnswer,
          onQuestionSkip,
          onFileClick,
          onEditedFileClick,
          onFixFinding,
          onFixAllFindings,
          isQuestionAnswered,
          getSubmittedAnswers,
          areQuestionsSkipped,
          isFindingFixed,
          onCopyToInput,
          hideApproveButtons,
        ]
      )

      const loadOlder = useCallback(() => {
        const container = scrollContainerRef.current
        if (
          !container ||
          !hasOlderOnDisk ||
          isLoadingOlder ||
          !onLoadOlderRuns ||
          pendingPrependScrollHeightRef.current !== null
        ) {
          return
        }
        pendingPrependScrollHeightRef.current = container.scrollHeight
        pendingPrependMessagesLengthRef.current = messages.length
        onLoadOlderRuns()
      }, [
        scrollContainerRef,
        hasOlderOnDisk,
        isLoadingOlder,
        onLoadOlderRuns,
        messages.length,
      ])

      // Restore scroll position after older messages prepend.
      useLayoutEffect(() => {
        const container = scrollContainerRef.current
        const before = pendingPrependScrollHeightRef.current
        const prevLen = pendingPrependMessagesLengthRef.current
        if (!container || before === null || prevLen === null) return
        if (isLoadingOlder) return

        pendingPrependScrollHeightRef.current = null
        pendingPrependMessagesLengthRef.current = null

        if (messages.length === prevLen) return

        flushSync(() => {
          /* trigger paint */
        })
        const delta = container.scrollHeight - before
        if (delta > 0) container.scrollTop += delta
      }, [scrollContainerRef, isLoadingOlder, messages.length])

      // Scroll-to-top auto-load.
      useEffect(() => {
        const container = scrollContainerRef.current
        if (!container || !hasOlderOnDisk || hasHiddenPrompts) return
        const handleScroll = () => {
          if (container.scrollTop < SCROLL_THRESHOLD) loadOlder()
        }
        container.addEventListener('scroll', handleScroll, { passive: true })
        return () => container.removeEventListener('scroll', handleScroll)
      }, [scrollContainerRef, hasOlderOnDisk, hasHiddenPrompts, loadOlder])

      // Scroll-to-bottom on new message arrival.
      const prevMessageCountRef = useRef(messages.length)
      useEffect(() => {
        if (
          shouldScrollToBottom &&
          messages.length > prevMessageCountRef.current
        ) {
          const lastEl = messageRefs.current.get(lastIndex)
          if (lastEl) {
            lastEl.scrollIntoView({ behavior: 'instant', block: 'end' })
            onScrollToBottomHandled?.()
          }
        }
        prevMessageCountRef.current = messages.length
      }, [
        messages.length,
        lastIndex,
        shouldScrollToBottom,
        onScrollToBottomHandled,
      ])

      useImperativeHandle(ref, () => ({
        scrollToIndex: (
          index: number,
          options?: { align?: 'start' | 'center' | 'end' }
        ) => {
          const el = messageRefs.current.get(index)
          if (el) {
            el.scrollIntoView({
              behavior: 'smooth',
              block: options?.align ?? 'start',
            })
          }
        },
        isIndexInView: (index: number) => {
          const el = messageRefs.current.get(index)
          const container = scrollContainerRef.current
          if (!el || !container) return false
          const rect = el.getBoundingClientRect()
          const containerRect = container.getBoundingClientRect()
          return (
            rect.top < containerRect.bottom && rect.bottom > containerRect.top
          )
        },
        getVisibleRange: () => ({ start: 0, end: lastIndex }),
      }))

      if (messages.length === 0) return null

      return (
        <div className="flex flex-col w-full">
          {(hasHiddenPrompts || hasOlderOnDisk) && (
            <button
              type="button"
              onClick={hasHiddenPrompts ? onShowHiddenPrompts : loadOlder}
              disabled={!hasHiddenPrompts && isLoadingOlder}
              className="w-full text-center text-muted-foreground text-xs py-2 opacity-60 hover:opacity-100 transition-opacity cursor-pointer disabled:cursor-wait"
            >
              {hasHiddenPrompts ? (
                `↑ Load old prompts (${hiddenPromptCount})`
              ) : isLoadingOlder ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading old prompts…
                </span>
              ) : (
                `↑ Load old prompts (${loadedRunStartIndex} older runs on disk)`
              )}
            </button>
          )}

          {renderItems.map(item => {
            if (item.kind === 'message') {
              const hasFollowUpMessage =
                item.message.role === 'assistant' &&
                hasFollowUpFor(item.globalIndex)
              return (
                <div
                  key={item.message.id}
                  ref={el => {
                    if (el) messageRefs.current.set(item.globalIndex, el)
                    else messageRefs.current.delete(item.globalIndex)
                  }}
                  className={
                    item.globalIndex === lastIndex && isSending ? '' : 'pb-4'
                  }
                >
                  {renderMessageItem(
                    { message: item.message, globalIndex: item.globalIndex },
                    {
                      hasFollowUpMessage,
                      durationMs: durationFor(item.globalIndex, item.message),
                    }
                  )}
                </div>
              )
            }

            if (item.kind === 'question') {
              const hasFollowUpMessage = hasFollowUpFor(item.globalIndex)
              return (
                <div
                  key={item.message.id}
                  ref={el => {
                    if (el) messageRefs.current.set(item.globalIndex, el)
                    else messageRefs.current.delete(item.globalIndex)
                  }}
                  className="pb-4"
                >
                  <CompactQuestionMessage
                    message={item.message}
                    globalIndex={item.globalIndex}
                    totalMessages={totalMessages}
                    hasFollowUpMessage={hasFollowUpMessage}
                    durationMs={durationFor(item.globalIndex, item.message)}
                    sessionId={sessionId}
                    onQuestionAnswer={onQuestionAnswer}
                    onQuestionSkip={onQuestionSkip}
                    isQuestionAnswered={isQuestionAnswered}
                    getSubmittedAnswers={getSubmittedAnswers}
                    areQuestionsSkipped={areQuestionsSkipped}
                    renderMessage={renderMessageItem}
                    hasFollowUpFor={hasFollowUpFor}
                    durationFor={durationFor}
                  />
                </div>
              )
            }

            const isLatestCompact =
              renderItems.length > 0 &&
              renderItems[renderItems.length - 1] === item
            const latestTextIsRecap =
              Boolean(item.latestText) &&
              RECAP_HEADING_RE.test(item.latestText ?? '')
            const showLatestText =
              isLatestCompact &&
              Boolean(item.latestText) &&
              !(latestTextIsRecap && latestRunHasPlan)
            const surfaceRecap = latestTextIsRecap && showLatestText
            return (
              <div key={item.key}>
                <CompactActivityRow
                  group={item.messages}
                  total={totalMessages}
                  renderMessage={renderMessageItem}
                  hasFollowUpFor={hasFollowUpFor}
                  durationFor={durationFor}
                  recapShownExternally={surfaceRecap}
                />
                {showLatestText && (
                  <div className="pb-4">
                    <Markdown
                      streaming={false}
                      messageId={item.key}
                      sessionId={sessionId}
                    >
                      {item.latestText ?? ''}
                    </Markdown>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )
    }
  )
)
