import {
  CheckCircle2,
  CircleDashed,
  Hourglass,
  Loader2,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

/**
 * Read-only pipeline verdict — icon **and** label, so the state never depends on
 * colour alone.
 *
 * The interactive `JenkinsStatusBadge` needs a project + worktree to drive its
 * re-run actions; this one only needs a status, which is what rows without a
 * worktree (PRs not checked out in Jean) have.
 */
export function JenkinsVerdict({
  status,
  className,
}: {
  status: JenkinsWorktreeStatus | undefined
  className?: string
}) {
  const verdict = verdictOf(status?.overallStatus)
  const build = status?.pipeline
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        verdict.text,
        className
      )}
      title={
        build
          ? `build-and-test #${build.number} — ${verdict.label}`
          : verdict.label
      }
    >
      {verdict.icon}
      {verdict.label}
    </span>
  )
}

function verdictOf(status: string | undefined): {
  label: string
  icon: React.ReactNode
  text: string
} {
  switch (status) {
    case 'SUCCESS':
      return {
        label: 'OK',
        icon: <CheckCircle2 className="size-3.5" />,
        text: 'text-green-600 dark:text-green-500',
      }
    case 'FAILURE':
      return {
        label: 'Échec',
        icon: <XCircle className="size-3.5" />,
        text: 'text-red-600 dark:text-red-400',
      }
    case 'BUILDING':
      return {
        label: 'En cours',
        icon: <Loader2 className="size-3.5 animate-spin" />,
        text: 'text-blue-600 dark:text-blue-400',
      }
    case 'QUEUED':
      return {
        label: 'En file',
        icon: <Hourglass className="size-3.5" />,
        text: 'text-amber-700 dark:text-amber-500',
      }
    default:
      return {
        label: 'Aucun build',
        icon: <CircleDashed className="size-3.5" />,
        text: 'text-muted-foreground',
      }
  }
}

export default JenkinsVerdict
