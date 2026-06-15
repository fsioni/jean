import { memo, useCallback } from 'react'
import { AlertCircle, ArrowDown, Check, ChevronDown } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import {
  ApprovalActionMenu,
  type ApprovalModelOverride,
} from './ApprovalModelSubmenu'

interface FloatingButtonsProps {
  /** Whether a plan needs approval (streaming or pending) */
  showApproveButton: boolean
  /** Whether findings exist and are not visible */
  showFindingsButton: boolean
  /** Whether user is at the bottom of scroll */
  isAtBottom: boolean
  /** Whether a message is currently streaming — drives new-activity indicator on Bottom button */
  isSending?: boolean
  /** Keyboard shortcut for approve */
  approveShortcut: string
  /** Callback for approve (build mode) */
  onApprove: () => void
  /** Callback for approve (yolo mode) */
  onYoloApprove: () => void
  /** Label for the build default backend/model */
  buildDefaultModelLabel?: string | null
  /** Label for the yolo default backend/model */
  yoloDefaultModelLabel?: string | null
  /** Callback for clear context build approval */
  onClearContextBuildApprove?: (override?: ApprovalModelOverride) => void
  /** Callback for clear context yolo approval */
  onClearContextApprove?: (override?: ApprovalModelOverride) => void
  /** Callback for worktree build approval */
  onWorktreeBuildApprove?: (override?: ApprovalModelOverride) => void
  /** Callback for worktree yolo approval */
  onWorktreeYoloApprove?: (override?: ApprovalModelOverride) => void
  /** Callback to scroll to findings */
  onScrollToFindings: () => void
  /** Callback to scroll to bottom */
  onScrollToBottom: () => void
}

/**
 * Floating action buttons (approve, findings, scroll to bottom)
 * Memoized to prevent re-renders when parent state changes
 */
export const FloatingButtons = memo(function FloatingButtons({
  showApproveButton: showApprove,
  showFindingsButton,
  isAtBottom,
  isSending,
  approveShortcut,
  onApprove,
  onYoloApprove,
  buildDefaultModelLabel,
  yoloDefaultModelLabel,
  onClearContextBuildApprove,
  onClearContextApprove,
  onWorktreeBuildApprove,
  onWorktreeYoloApprove,
  onScrollToFindings,
  onScrollToBottom,
}: FloatingButtonsProps) {
  const showApproveButton = showApprove && !isAtBottom

  const withScroll = useCallback(
    (
      fn?: (override?: ApprovalModelOverride) => void,
      override?: ApprovalModelOverride
    ) =>
      () => {
        fn?.(override)
        onScrollToBottom()
      },
    [onScrollToBottom]
  )

  return (
    <>
      {/* Right side - Approve, Findings, Bottom buttons */}
      <div className="absolute bottom-4 right-4 flex gap-2">
        {/* Floating approval buttons with dropdowns - shown when main approve buttons are not visible */}
        {showApproveButton && (
          <div className="flex gap-2">
            <div className="inline-flex shadow-md rounded-lg">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 rounded-r-none text-sm"
                    onClick={withScroll(onYoloApprove)}
                  >
                    YOLO
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Approve with yolo mode (
                  {formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan_yolo)}
                  )
                </TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="h-8 px-1.5 rounded-l-none border-l border-l-primary-foreground/20"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <ApprovalActionMenu
                    yoloDefaultModelLabel={yoloDefaultModelLabel}
                    clearContextShortcut={formatShortcutDisplay(
                      DEFAULT_KEYBINDINGS.approve_plan_clear_context
                    )}
                    worktreeYoloShortcut={formatShortcutDisplay(
                      DEFAULT_KEYBINDINGS.approve_plan_worktree_yolo
                    )}
                    onClearContextApprove={
                      onClearContextApprove
                        ? (override?: ApprovalModelOverride) => {
                            onClearContextApprove(override)
                            onScrollToBottom()
                          }
                        : undefined
                    }
                    onWorktreeYoloApprove={
                      onWorktreeYoloApprove
                        ? (override?: ApprovalModelOverride) => {
                            onWorktreeYoloApprove(override)
                            onScrollToBottom()
                          }
                        : undefined
                    }
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="inline-flex shadow-md rounded-lg">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 rounded-r-none text-sm"
                    onClick={withScroll(onApprove)}
                  >
                    <Check className="h-3.5 w-3.5" />
                    Approve
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Approve plan ({approveShortcut})
                </TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-1.5 rounded-l-none border-l border-l-border"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <ApprovalActionMenu
                    buildDefaultModelLabel={buildDefaultModelLabel}
                    clearContextBuildShortcut={formatShortcutDisplay(
                      DEFAULT_KEYBINDINGS.approve_plan_clear_context_build
                    )}
                    worktreeBuildShortcut={formatShortcutDisplay(
                      DEFAULT_KEYBINDINGS.approve_plan_worktree_build
                    )}
                    onClearContextBuildApprove={
                      onClearContextBuildApprove
                        ? (override?: ApprovalModelOverride) => {
                            onClearContextBuildApprove(override)
                            onScrollToBottom()
                          }
                        : undefined
                    }
                    onWorktreeBuildApprove={
                      onWorktreeBuildApprove
                        ? (override?: ApprovalModelOverride) => {
                            onWorktreeBuildApprove(override)
                            onScrollToBottom()
                          }
                        : undefined
                    }
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
        {/* Go to findings button - shown when findings exist and are not visible */}
        {showFindingsButton && (
          <button
            type="button"
            onClick={onScrollToFindings}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-muted/90 px-3 text-sm text-muted-foreground shadow-md transition-colors hover:bg-muted hover:text-foreground"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            <span>Findings</span>
          </button>
        )}
        {/* Scroll to bottom button */}
        {!isAtBottom && (
          <button
            type="button"
            onClick={onScrollToBottom}
            className="relative flex h-8 items-center gap-1.5 rounded-lg bg-muted px-3 text-sm text-muted-foreground shadow-md transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            <span>Bottom</span>
            {isSending && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 flex h-2 w-2"
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
            )}
          </button>
        )}
      </div>
    </>
  )
})
