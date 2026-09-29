import { useCallback, useState } from 'react'
import { Flag } from '@/components/icons/reicon'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface GoalBadgeProps {
  sessionId: string
  /** Objective set by the user message that renders this badge */
  objective: string
  onClearGoal: () => Promise<void>
}

/** Shown on the user message that set the session's active goal. */
export function GoalBadge({
  sessionId,
  objective,
  onClearGoal,
}: GoalBadgeProps) {
  const isActive = useChatStore(
    state => state.codexGoals[sessionId]?.trim() === objective
  )
  const [clearing, setClearing] = useState(false)
  const [open, setOpen] = useState(false)

  const handleClear = useCallback(async () => {
    if (clearing) return
    setClearing(true)
    try {
      await onClearGoal()
      setOpen(false)
    } catch (err) {
      toast.error(`Failed to clear goal: ${err}`)
    } finally {
      setClearing(false)
    }
  }, [clearing, onClearGoal])

  if (!isActive) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Show goal"
          className="flex h-6 items-center gap-1 rounded-full border border-border/70 bg-background/90 py-0 pl-1.5 pr-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Flag className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Goal</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Goal
        </div>
        <div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground">
          {objective}
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClear}
            disabled={clearing}
          >
            {clearing ? 'Clearing...' : 'Clear goal'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
