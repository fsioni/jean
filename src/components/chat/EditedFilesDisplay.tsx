import { memo, useMemo, useState } from 'react'
import { diffLines } from 'diff'
import type { ToolCall, ChatMessage } from '@/types/chat'
import { Badge } from '@/components/ui/badge'
import { getFilename } from '@/lib/path-utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { MessageDiffModal } from './MessageDiffModal'
import type { EditTool } from './MessageDiffModal'

function isEditTool(
  toolCall: ToolCall
): toolCall is ToolCall & { input: EditTool['input'] } {
  return (
    toolCall.name === 'Edit' &&
    typeof toolCall.input === 'object' &&
    toolCall.input !== null &&
    'file_path' in toolCall.input &&
    typeof (toolCall.input as Record<string, unknown>).file_path === 'string'
  )
}

function computeEditStats(
  oldStr: string | undefined,
  newStr: string | undefined
): { additions: number; deletions: number } {
  const changes = diffLines(oldStr ?? '', newStr ?? '')
  let additions = 0
  let deletions = 0
  for (const part of changes) {
    const count = part.count ?? 0
    if (part.added) additions += count
    else if (part.removed) deletions += count
  }
  return { additions, deletions }
}

interface EditedFilesDisplayProps {
  toolCalls: ToolCall[] | undefined
  worktreePath?: string
  /**
   * Stable accessor for the full session message list. Used to compute
   * "subsequent edits" lazily when the user opens a diff. Passing a stable
   * function (rather than the `messages` array itself) keeps the memoized
   * row from re-rendering whenever the session's message array identity
   * changes — avoiding a per-row render cascade while scrolling.
   */
  getMessages?: () => ChatMessage[]
  messageIndex?: number
}

export const EditedFilesDisplay = memo(function EditedFilesDisplay({
  toolCalls,
  worktreePath,
  getMessages,
  messageIndex,
}: EditedFilesDisplayProps) {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)

  const editTools = useMemo(
    () => (toolCalls ?? []).filter(isEditTool),
    [toolCalls]
  )

  const uniqueFilePaths = useMemo(
    () => Array.from(new Set(editTools.map(t => t.input.file_path))),
    [editTools]
  )

  const fileStats = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>()
    for (const tool of editTools) {
      const prev = map.get(tool.input.file_path) ?? {
        additions: 0,
        deletions: 0,
      }
      const delta = computeEditStats(
        tool.input.old_string,
        tool.input.new_string
      )
      map.set(tool.input.file_path, {
        additions: prev.additions + delta.additions,
        deletions: prev.deletions + delta.deletions,
      })
    }
    return map
  }, [editTools])

  const selectedEdits = useMemo(
    () =>
      selectedFilePath
        ? editTools.filter(t => t.input.file_path === selectedFilePath)
        : [],
    [editTools, selectedFilePath]
  )

  // All Edit tool calls on selectedFilePath from messages AFTER this one.
  // Computed lazily — only once the user opens a diff — by pulling the
  // current message list through the stable `getMessages` accessor.
  const subsequentEdits = useMemo(() => {
    if (!selectedFilePath || !getMessages || messageIndex == null) return []
    return getMessages()
      .slice(messageIndex + 1)
      .flatMap(msg => (msg.tool_calls ?? []).filter(isEditTool))
      .filter(t => t.input.file_path === selectedFilePath)
  }, [selectedFilePath, getMessages, messageIndex])

  if (editTools.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/70">
      <span>
        Edited {uniqueFilePaths.length} file
        {uniqueFilePaths.length === 1 ? '' : 's'}:
      </span>

      {uniqueFilePaths.map(filePath => {
        const stats = fileStats.get(filePath)
        return (
          <Tooltip key={filePath}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setSelectedFilePath(filePath)}
                aria-label={`View changes to ${getFilename(filePath)}`}
                className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Badge variant="outline" className="cursor-pointer gap-1.5">
                  {getFilename(filePath)}
                  {stats && (stats.additions > 0 || stats.deletions > 0) && (
                    <span className="flex items-center font-mono text-xs opacity-80">
                      <span className="text-green-500">+{stats.additions}</span>
                      <span className="text-muted-foreground mx-0.5">/</span>
                      <span className="text-red-500">-{stats.deletions}</span>
                    </span>
                  )}
                </Badge>
              </button>
            </TooltipTrigger>
            <TooltipContent>{filePath}</TooltipContent>
          </Tooltip>
        )
      })}

      {selectedFilePath && (
        <MessageDiffModal
          isOpen={true}
          onClose={() => setSelectedFilePath(null)}
          filePath={selectedFilePath}
          edits={selectedEdits}
          subsequentEdits={subsequentEdits}
          worktreePath={worktreePath}
        />
      )}
    </div>
  )
})
