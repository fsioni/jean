import { useState } from 'react'
import { ChevronRight } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import {
  useAgentDetails,
  useMarkAgentNotificationsRead,
  type AgentNotification,
  type AgentSummary,
} from '@/services/agents'
import { formatRelative } from './AgentActivity'

const LEVEL_STYLES: Record<string, string> = {
  action: 'border-amber-500/40 bg-amber-500/5',
  error: 'border-destructive/40 bg-destructive/5',
  info: '',
}

function NotificationRow({
  notification,
}: {
  notification: AgentNotification
}) {
  return (
    <li
      className={cn(
        'rounded-md border px-3 py-2',
        LEVEL_STYLES[notification.level],
        notification.readAt !== null && 'opacity-60'
      )}
    >
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
        {notification.message}
      </p>
      <p className="text-xs text-muted-foreground">
        {notification.level === 'action'
          ? 'Needs you'
          : notification.level === 'error'
            ? 'Error'
            : 'Info'}{' '}
        · {formatRelative(notification.createdAt)}
      </p>
    </li>
  )
}

/** Unread first (newest first), read ones apart for the collapsed section. */
export function splitNotifications(notifications: AgentNotification[]): {
  unread: AgentNotification[]
  read: AgentNotification[]
} {
  return {
    unread: notifications.filter(n => n.readAt === null),
    read: notifications.filter(n => n.readAt !== null),
  }
}

/** Messages the agent sent with `notify_user`: results, questions, errors. */
export function AgentInbox({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  const markRead = useMarkAgentNotificationsRead()
  const [readOpen, setReadOpen] = useState(false)
  const { unread, read } = splitNotifications(data?.notifications ?? [])
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Results, questions and errors the agent reports to you.
        </p>
        {agent.unreadNotifications > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate({ agentId: agent.id })}
          >
            Mark all read
          </Button>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading inbox…</p>
      ) : unread.length === 0 && read.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing yet.</p>
      ) : (
        <>
          {unread.length > 0 ? (
            <ul className="space-y-2">
              {unread.map(notification => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No new messages.</p>
          )}
          {read.length > 0 && (
            <Collapsible open={readOpen} onOpenChange={setReadOpen}>
              <CollapsibleTrigger className="flex items-center gap-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
                <ChevronRight
                  className={cn(
                    'size-3.5 transition-transform',
                    readOpen && 'rotate-90'
                  )}
                />
                Read ({read.length})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-2 space-y-2">
                  {read.map(notification => (
                    <NotificationRow
                      key={notification.id}
                      notification={notification}
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
    </div>
  )
}
