import React, { useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { openExternal } from '@/lib/platform'
import {
  isClickUpAuthError,
  useAssignClickUpToMe,
  useClickUpMe,
  useClickUpStatusOptions,
  useClickUpTask,
  useResolvedClickUpTaskId,
  useUpdateClickUpStatus,
} from '@/services/clickup'

interface ClickUpTaskCardProps {
  worktreeId: string | null
  projectId: string | null
  className?: string
  /** Show the task title (default true). Hidden where the title is redundant. */
  showTitle?: boolean
}

/**
 * Inline ClickUp task display for the chat toolbar: task name + status picker +
 * self-assign, styled to blend with the surrounding toolbar (borderless, muted,
 * `text-xs`). Renders nothing when no task is linked.
 */
export const ClickUpTaskCard: React.FC<ClickUpTaskCardProps> = ({
  worktreeId,
  projectId,
  className,
  showTitle = true,
}) => {
  const { data: taskId } = useResolvedClickUpTaskId(worktreeId)
  const {
    data: task,
    isLoading,
    error,
  } = useClickUpTask(taskId ?? null, projectId)
  const { data: statusOptions } = useClickUpStatusOptions()
  const { data: me } = useClickUpMe(projectId)

  const updateStatus = useUpdateClickUpStatus(projectId)
  const assignToMe = useAssignClickUpToMe(projectId)

  const handleStatusChange = useCallback(
    (status: string) => {
      if (!taskId || status === task?.status?.status) return
      updateStatus.mutate(
        { taskId, status },
        {
          onSuccess: () => toast.success(`Statut → ${status}`),
          onError: e => toast.error(`Échec changement de statut : ${e}`),
        }
      )
    },
    [taskId, task?.status?.status, updateStatus]
  )

  const handleAssignToMe = useCallback(() => {
    if (!taskId) return
    assignToMe.mutate(
      { taskId },
      {
        onSuccess: () => toast.success('Tâche assignée'),
        onError: e => toast.error(`Échec de l'assignation : ${e}`),
      }
    )
  }, [taskId, assignToMe])

  // No linked task → render nothing (linking happens in the ClickUp popover).
  if (!taskId) return null

  if (isLoading) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        CU-{taskId}
      </span>
    )
  }

  if (error) {
    return (
      <span className="truncate text-xs text-muted-foreground">
        {isClickUpAuthError(error)
          ? 'Token ClickUp manquant'
          : 'ClickUp indisponible'}
      </span>
    )
  }

  if (!task) return null

  const isAssignedToMe = !!me && task.assignees.some(a => a.id === me.id)
  const statusColor = task.status?.color ?? undefined

  return (
    <div className={cn('flex min-w-0 items-center gap-0.5 text-xs', className)}>
      {showTitle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => task.url && openExternal(task.url)}
              disabled={!task.url}
              className="min-w-0 max-w-[min(22vw,220px)] truncate text-muted-foreground transition-colors hover:text-foreground"
            >
              {task.name}
            </button>
          </TooltipTrigger>
          <TooltipContent>Ouvrir dans ClickUp (CU-{task.id})</TooltipContent>
        </Tooltip>
      )}

      {/* Status picker (hard-coded Planexpo transitions) */}
      <Select
        value={task.status?.status ?? ''}
        onValueChange={handleStatusChange}
        disabled={updateStatus.isPending}
      >
        <SelectTrigger
          size="sm"
          className="h-6 w-auto shrink-0 gap-1 rounded border-0 bg-transparent px-1.5 text-xs font-medium text-muted-foreground shadow-none transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:ring-0 [&>svg]:size-3 [&>svg]:opacity-50"
        >
          {updateStatus.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={
                  statusColor ? { backgroundColor: statusColor } : undefined
                }
              />
              <SelectValue placeholder="Statut" />
            </span>
          )}
        </SelectTrigger>
        <SelectContent>
          {(statusOptions ?? []).map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Self-assign (hidden when already mine) */}
      {!isAssignedToMe && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
              onClick={handleAssignToMe}
              disabled={assignToMe.isPending}
            >
              {assignToMe.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <UserPlus className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>M&apos;assigner cette tâche</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
