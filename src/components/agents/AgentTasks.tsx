import { Suspense, lazy, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  useAgentDetails,
  type AgentSummary,
  type AgentTask,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { formatRelative } from './AgentActivity'

const ChatWindow = lazy(() =>
  import('@/components/chat/ChatWindow').then(mod => ({
    default: mod.ChatWindow,
  }))
)

const KIND_LABELS: Record<string, string> = {
  schedule: 'Schedule',
  delegation: 'Follow-up',
  message: 'Agent request',
  approval: 'Approval',
}

const STATUS_STYLES: Record<string, string> = {
  running: 'text-primary',
  waiting: 'text-amber-600 dark:text-amber-400',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  done: 'text-muted-foreground',
}

/** Status text: "waiting" means the task waits for work it handed off. */
export function taskStatusLabel(status: string): string {
  return status === 'waiting' ? 'waiting for sessions' : status
}

function TaskRow({
  task,
  onOpen,
}: {
  task: AgentTask
  onOpen: (task: AgentTask) => void
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/50"
        onClick={() => onOpen(task)}
      >
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 text-sm">
            <span className="truncate text-foreground">{task.title}</span>
            <span
              className={cn('shrink-0 text-xs', STATUS_STYLES[task.status])}
            >
              {taskStatusLabel(task.status)}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {KIND_LABELS[task.kind] ?? task.kind} ·{' '}
            {formatRelative(task.updatedAt)}
          </p>
          {task.summary ? (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {task.summary}
            </p>
          ) : null}
        </div>
      </button>
    </li>
  )
}

/** Background tasks of an agent; a task opens its own session. */
export function AgentTasks({
  agent,
  workdir,
}: {
  agent: AgentSummary
  workdir: string | undefined
}) {
  const { data, isLoading } = useAgentDetails(agent.id)
  const [openTask, setOpenTask] = useState<AgentTask | null>(null)

  const handleOpen = (task: AgentTask) => {
    useChatStore
      .getState()
      .setActiveSession(agent.tasksWorktreeId, task.sessionId)
    setOpenTask(task)
  }

  if (openTask && workdir) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <Button size="sm" variant="ghost" onClick={() => setOpenTask(null)}>
            ← Back to tasks
          </Button>
          <span className="truncate text-sm text-foreground">
            {openTask.title}
          </span>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Loading task…
              </div>
            }
          >
            <ChatWindow
              key={openTask.sessionId}
              isModal
              worktreeId={agent.tasksWorktreeId}
              worktreePath={workdir}
            />
          </Suspense>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
      <p className="text-xs text-muted-foreground">
        Schedules, follow-ups and agent requests run here, apart from your chat.
        Finished tasks are archived after 3 days.
      </p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading tasks…</p>
      ) : data?.tasks.length ? (
        <ul className="space-y-2">
          {data.tasks.map(task => (
            <TaskRow key={task.id} task={task} onOpen={handleOpen} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No open tasks.</p>
      )}
    </div>
  )
}
