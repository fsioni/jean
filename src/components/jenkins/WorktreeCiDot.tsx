import type { ReactNode } from 'react'
import { Loader2, XCircle, Hourglass, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useJenkinsStatusCached } from '@/services/jenkins'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

interface WorktreeCiDotProps {
  worktreeId: string
  /** GitHub PR number as a string (or null). CI lives at the PR level. */
  prId?: string | null
}

interface DotSpec {
  icon: ReactNode
  tone: string
  tooltip: string
}

const ICON = 'size-3 shrink-0'

/**
 * Only the ACTIONABLE states get a dot — a worktree that is working (CI running)
 * or that needs me (failed / queued / preview down). Success and idle render
 * nothing so the sidebar stays calm; the meaning is the icon SHAPE + tooltip
 * (never color alone), for colorblind readability.
 */
function dotFor(status: JenkinsWorktreeStatus): DotSpec | null {
  switch (status.overallStatus) {
    case 'BUILDING':
      return {
        icon: <Loader2 className={cn(ICON, 'animate-spin')} />,
        tone: 'text-blue-600 dark:text-blue-400',
        tooltip: 'Pipeline en cours — ce worktree travaille',
      }
    case 'FAILURE':
      return {
        icon: <XCircle className={ICON} />,
        tone: 'text-red-600 dark:text-red-400',
        tooltip: 'Pipeline en échec — à corriger',
      }
    case 'QUEUED':
      return {
        icon: <Hourglass className={ICON} />,
        tone: 'text-amber-600 dark:text-amber-400',
        tooltip: "Pipeline en file d'attente",
      }
    default:
      // SUCCESS / UNKNOWN: surface a down preview as the only remaining signal.
      if (status.previewUrl && status.previewFreshness?.status === 'DOWN') {
        return {
          icon: <Globe className={ICON} />,
          tone: 'text-red-600 dark:text-red-400',
          tooltip: 'Preview hors ligne',
        }
      }
      return null
  }
}

/**
 * Compact CI pastille shown at the LEFT of a worktree row in the sidebar, next
 * to the chat status dot. Tells at a glance which worktree is working or needs
 * attention, without reading the detailed CI pills. Cache-only (poller-fed);
 * never fetches.
 */
export function WorktreeCiDot({ worktreeId, prId }: WorktreeCiDotProps) {
  const { data: status } = useJenkinsStatusCached(worktreeId)
  if (!prId || !status) return null

  const spec = dotFor(status)
  if (!spec) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('inline-flex shrink-0 items-center', spec.tone)}
          aria-label={spec.tooltip}
        >
          {spec.icon}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{spec.tooltip}</TooltipContent>
    </Tooltip>
  )
}
