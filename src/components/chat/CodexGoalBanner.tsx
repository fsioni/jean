import { useCallback, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import { Button } from '@/components/ui/button'

interface CodexGoalBannerProps {
  sessionId: string | null
  worktreeId: string | null
  worktreePath: string | null
  /** Only render for codex backend sessions */
  isCodexBackend: boolean
}

export function CodexGoalBanner({
  sessionId,
  worktreeId,
  worktreePath,
  isCodexBackend,
}: CodexGoalBannerProps) {
  const goal = useChatStore(state =>
    sessionId ? (state.codexGoals[sessionId] ?? null) : null
  )
  const [clearing, setClearing] = useState(false)

  const handleClear = useCallback(async () => {
    if (!sessionId || !worktreeId || !worktreePath || clearing) return
    setClearing(true)
    try {
      await invoke('codex_goal_clear', {
        worktreeId,
        worktreePath,
        sessionId,
      })
    } catch (err) {
      toast.error(`Failed to clear goal: ${err}`)
    } finally {
      setClearing(false)
    }
  }, [sessionId, worktreeId, worktreePath, clearing])

  if (!isCodexBackend || !goal) return null

  return (
    <div className="mb-2 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      <div className="flex-1">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Goal
        </div>
        <div className="text-foreground">{goal}</div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={handleClear}
        disabled={clearing}
        aria-label="Clear goal"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
