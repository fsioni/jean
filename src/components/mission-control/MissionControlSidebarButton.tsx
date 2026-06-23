import { useCallback } from 'react'
import { Rocket, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUIStore } from '@/store/ui-store'
import { useMissionControlRows } from './useMissionControlRows'

/**
 * Permanent sidebar entry opening the Jenkins Mission Control view, with an
 * ambient failure counter so a broken pipeline is visible WITHOUT opening it.
 *
 * Owns the `useMissionControlRows` subscription itself so the poller's live
 * updates re-render only this button, not the whole project tree. The count is
 * carried by an icon + number + tooltip (not color alone) for colorblind users.
 */
export function MissionControlSidebarButton({
  isNarrow,
}: {
  isNarrow: boolean
}) {
  const open = useUIStore(state => state.missionControlOpen)
  const { failureCount } = useMissionControlRows()

  const handleClick = useCallback(() => {
    useUIStore.getState().setMissionControlOpen(true)
  }, [])

  const badge =
    failureCount > 0 ? (
      <span
        className="inline-flex items-center gap-0.5 rounded bg-red-500/10 px-1 py-0.5 text-[10px] font-semibold leading-none text-red-600 dark:text-red-400"
        title={`${failureCount} pipeline${failureCount > 1 ? 's' : ''} en échec`}
      >
        <XCircle className="size-2.5" />
        {failureCount}
      </span>
    ) : null

  const button = (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Mission Control"
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm transition-colors',
        isNarrow && 'justify-center px-0',
        open
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      )}
    >
      <Rocket className="size-3.5 shrink-0" />
      {!isNarrow && (
        <span className="flex-1 truncate text-left">Mission Control</span>
      )}
      {badge}
    </button>
  )

  // When the label is hidden, surface the name + count via a tooltip.
  if (isNarrow) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">
          Mission Control
          {failureCount > 0 ? ` — ${failureCount} en échec` : ''}
        </TooltipContent>
      </Tooltip>
    )
  }

  return button
}
