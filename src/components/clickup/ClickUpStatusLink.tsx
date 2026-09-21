import { useResolvedClickUpTaskId, useClickUpTask } from '@/services/clickup'
import { openExternal } from '@/lib/platform'

export function ClickUpStatusLink({
  projectId,
  worktreeId,
}: {
  projectId: string
  worktreeId: string
}) {
  const { data: taskId } = useResolvedClickUpTaskId(worktreeId)
  const { data: task } = useClickUpTask(taskId ?? null, projectId)

  if (!task?.url) return null

  return (
    <button
      type="button"
      className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
      title={`Open ClickUp ticket ${task.id}`}
      onClick={event => {
        event.stopPropagation()
        openExternal(task.url!)
      }}
    >
      {task.status?.status ?? task.id}
    </button>
  )
}
