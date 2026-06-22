import { Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { useJenkinsStatusCached } from '@/services/jenkins'
import { useProjects } from '@/services/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

interface WorktreeStatusDotProps {
  projectId: string
  worktreeId: string
  /** GitHub PR number as a string (or null). The badge lives at the PR level. */
  prId?: string | null
}

/** Verdict dot color + human label for the global build-and-test status. */
function verdictView(status: string): { dot: string; label: string } | null {
  switch (status) {
    case 'SUCCESS':
      return { dot: 'bg-green-500', label: 'build-and-test : Passing' }
    case 'FAILURE':
      return { dot: 'bg-red-500', label: 'build-and-test : Failing' }
    case 'BUILDING':
      return {
        dot: 'bg-blue-500 animate-pulse',
        label: 'build-and-test : Building',
      }
    case 'QUEUED':
      return { dot: 'bg-amber-500', label: "build-and-test : en file d'attente" }
    default:
      // UNKNOWN — no verdict to show.
      return null
  }
}

/** Preview freshness → micro-dot color + label, or null when there's nothing. */
function previewView(
  status: JenkinsWorktreeStatus
): { dot: string; label: string } | null {
  if (!status.previewUrl) return null
  switch (status.previewFreshness?.status) {
    case 'UP_TO_DATE':
      return { dot: 'bg-green-500', label: 'Preview à jour' }
    case 'STALE':
      return { dot: 'bg-amber-500', label: 'Preview périmée' }
    case 'DOWN':
      return { dot: 'bg-red-500', label: 'Preview hors ligne' }
    default:
      return null
  }
}

/** True once the poller has filled the cache with a real verdict for this row. */
function hasRealData(status: JenkinsWorktreeStatus | undefined): status is JenkinsWorktreeStatus {
  if (!status) return false
  return !(
    status.overallStatus === 'UNKNOWN' &&
    status.pipeline === null &&
    status.stages.length === 0 &&
    status.preview === null
  )
}

/**
 * Compact, non-interactive Jenkins status dot for worktree LIST rows (sidebar &
 * canvas) — visible without entering the worktree.
 *
 * Reads the poller-fed cache only (`useJenkinsStatusCached`); it never triggers
 * a fetch, so it scales to N rows. The detailed popover stays in the worktree
 * (`JenkinsStatusBadge` / `PreviewBadge`).
 *
 * Rendering:
 * - no PR → nothing (the badge lives where the PR lives);
 * - PR + real verdict in cache → verdict dot (+ optional preview-freshness dot);
 * - PR but project has no Jenkins config → grey "CI ⚙" hint (cause C diagnostic);
 * - PR, project configured, not polled yet → nothing (waiting on the first cycle).
 */
export function WorktreeStatusDot({
  projectId,
  worktreeId,
  prId,
}: WorktreeStatusDotProps) {
  const { data: status } = useJenkinsStatusCached(worktreeId)
  const { data: projects = [] } = useProjects()

  // The badge only makes sense for a PR-linked worktree.
  if (!prId) return null

  if (!hasRealData(status)) {
    // PR but no real verdict yet. If the project isn't configured at all, the
    // poller will never emit for it — surface that as a clear, in-context hint
    // rather than staying silent (notif-diagnostic cause C).
    const project = projects.find(p => p.id === projectId)
    const jenkinsConfigured =
      !!project?.jenkins_url ||
      !!project?.jenkins_user ||
      !!project?.jenkins_token ||
      !!project?.jenkins_preview_url_template
    if (jenkinsConfigured) return null

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium text-muted-foreground/70">
            CI
            <Settings2 className="h-2.5 w-2.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Jenkins non configuré — Réglages du projet
        </TooltipContent>
      </Tooltip>
    )
  }

  const verdict = verdictView(status.overallStatus)
  const preview = previewView(status)
  if (!verdict && !preview) return null

  const tooltip = [verdict?.label, preview?.label].filter(Boolean).join(' · ')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1">
          {verdict && (
            <span
              className={cn('h-2 w-2 shrink-0 rounded-full', verdict.dot)}
            />
          )}
          {preview && (
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-background',
                preview.dot
              )}
            />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
