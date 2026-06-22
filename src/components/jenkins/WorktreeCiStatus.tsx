import type { ReactNode } from 'react'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Hourglass,
  Globe,
  Settings2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { useJenkinsStatusCached } from '@/services/jenkins'
import { useProjects } from '@/services/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

interface WorktreeCiStatusProps {
  projectId: string
  worktreeId: string
  /** GitHub PR number as a string (or null). The badge lives at the PR level. */
  prId?: string | null
}

interface PillSpec {
  key: string
  icon: ReactNode
  label: string
  tone: string
  tooltip: string
}

/**
 * Meaning is carried by the ICON SHAPE + TEXT label so the status is readable
 * without relying on color (accessible to colorblind users). Color is only a
 * redundant secondary cue.
 */
const TONE = {
  green:
    'text-green-700 dark:text-green-400 border-green-600/30 bg-green-500/10',
  red: 'text-red-700 dark:text-red-400 border-red-600/30 bg-red-500/10',
  amber:
    'text-amber-700 dark:text-amber-400 border-amber-600/30 bg-amber-500/10',
  blue: 'text-blue-700 dark:text-blue-400 border-blue-600/30 bg-blue-500/10',
  muted: 'text-muted-foreground border-border bg-muted/40',
} as const

const ICON = 'size-3 shrink-0'

/** build-and-test verdict → a shaped, labelled pill (or null for UNKNOWN). */
function verdictPill(status: string): PillSpec | null {
  switch (status) {
    case 'SUCCESS':
      return {
        key: 'ci',
        icon: <CheckCircle2 className={ICON} />,
        label: 'CI OK',
        tone: TONE.green,
        tooltip: 'build-and-test : réussi',
      }
    case 'FAILURE':
      return {
        key: 'ci',
        icon: <XCircle className={ICON} />,
        label: 'CI échec',
        tone: TONE.red,
        tooltip: 'build-and-test : en échec',
      }
    case 'BUILDING':
      return {
        key: 'ci',
        icon: <Loader2 className={cn(ICON, 'animate-spin')} />,
        label: 'CI en cours',
        tone: TONE.blue,
        tooltip: 'build-and-test : en cours',
      }
    case 'QUEUED':
      return {
        key: 'ci',
        icon: <Hourglass className={ICON} />,
        label: 'CI en file',
        tone: TONE.amber,
        tooltip: "build-and-test : en file d'attente",
      }
    default:
      return null
  }
}

/** Preview freshness → a shaped, labelled pill (or null when nothing to show). */
function previewPill(status: JenkinsWorktreeStatus): PillSpec | null {
  if (!status.previewUrl) return null
  switch (status.previewFreshness?.status) {
    case 'UP_TO_DATE':
      return {
        key: 'preview',
        icon: <Globe className={ICON} />,
        label: 'Preview à jour',
        tone: TONE.green,
        tooltip: 'Preview à jour avec la PR',
      }
    case 'STALE':
      return {
        key: 'preview',
        icon: <Globe className={ICON} />,
        label: 'Preview périmée',
        tone: TONE.amber,
        tooltip: 'Preview périmée — en retard sur la PR',
      }
    case 'DOWN':
      return {
        key: 'preview',
        icon: <Globe className={ICON} />,
        label: 'Preview hors ligne',
        tone: TONE.red,
        tooltip: 'Preview hors ligne (injoignable)',
      }
    default:
      return null
  }
}

/** True once the poller has filled the cache with a real verdict for this row. */
function hasRealData(
  status: JenkinsWorktreeStatus | undefined
): status is JenkinsWorktreeStatus {
  if (!status) return false
  return !(
    status.overallStatus === 'UNKNOWN' &&
    status.pipeline === null &&
    status.stages.length === 0 &&
    status.preview === null
  )
}

function Pill({ spec }: { spec: PillSpec }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-none',
            spec.tone
          )}
        >
          {spec.icon}
          {spec.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{spec.tooltip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Jenkins status for a worktree LIST row (sidebar & canvas), shown as compact,
 * **shaped + labelled pills** on their own line — readable without color.
 *
 * Reads the poller-fed cache only (`useJenkinsStatusCached`); never fetches, so
 * it scales to N rows. The detailed popovers stay in the worktree
 * (`JenkinsStatusBadge` / `PreviewBadge`).
 *
 * Renders nothing when: no PR; project configured but not polled yet. Shows a
 * "CI non configuré" pill for a PR worktree whose project has no Jenkins config.
 */
export function WorktreeCiStatus({
  projectId,
  worktreeId,
  prId,
}: WorktreeCiStatusProps) {
  const { data: status } = useJenkinsStatusCached(worktreeId)
  const { data: projects = [] } = useProjects()

  if (!prId) return null

  if (!hasRealData(status)) {
    const project = projects.find(p => p.id === projectId)
    const jenkinsConfigured =
      !!project?.jenkins_url ||
      !!project?.jenkins_user ||
      !!project?.jenkins_token ||
      !!project?.jenkins_preview_url_template
    if (jenkinsConfigured) return null

    return (
      <div className="flex flex-wrap items-center gap-1">
        <Pill
          spec={{
            key: 'unconfigured',
            icon: <Settings2 className={ICON} />,
            label: 'CI non configuré',
            tone: TONE.muted,
            tooltip: 'Jenkins non configuré — Réglages du projet',
          }}
        />
      </div>
    )
  }

  const pills = [verdictPill(status.overallStatus), previewPill(status)].filter(
    (p): p is PillSpec => p !== null
  )
  if (pills.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1">
      {pills.map(spec => (
        <Pill key={spec.key} spec={spec} />
      ))}
    </div>
  )
}
