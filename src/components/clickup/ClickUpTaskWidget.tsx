import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import {
  useHasClickUpAccess,
  useResolvedClickUpTaskId,
} from '@/services/clickup'
import { ClickUpTaskCard } from './ClickUpTaskCard'
import { ClickUpTaskTab } from './ClickUpTaskTab'

interface ClickUpTaskWidgetProps {
  worktreeId: string | null
  projectId: string | null
  /** Show the task title in the inline card (default true). */
  showTitle?: boolean
}

/**
 * ClickUp integration rendered inline inside the chat toolbar row: a ClickUp
 * button (opens the link/browse popover) + the inline task card + a trailing
 * divider, so it reads as part of the toolbar instead of adding a row.
 *
 * Renders nothing when ClickUp is unconfigured and no task is linked.
 */
export const ClickUpTaskWidget: React.FC<ClickUpTaskWidgetProps> = ({
  worktreeId,
  projectId,
  showTitle = true,
}) => {
  const [open, setOpen] = useState(false)
  const hasAccess = useHasClickUpAccess(projectId)
  const { data: linkedTaskId } = useResolvedClickUpTaskId(worktreeId)

  if (!hasAccess && !linkedTaskId) return null

  return (
    <div className="flex min-w-0 shrink items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                aria-label="ClickUp"
              >
                <ClickUpIcon size={14} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Tâche ClickUp</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" className="w-80 p-0">
          <ClickUpTaskTab worktreeId={worktreeId} projectId={projectId} />
        </PopoverContent>
      </Popover>

      <ClickUpTaskCard
        worktreeId={worktreeId}
        projectId={projectId}
        showTitle={showTitle}
        className="min-w-0"
      />
    </div>
  )
}
