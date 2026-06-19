import { useCallback } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useJenkinsStatus } from '@/services/jenkins'
import type { PreviewFreshness } from '@/types/jenkins'

interface PreviewBadgeProps {
  projectId: string
  worktreeId: string
  /** GitHub PR number as a string (or null). */
  prId?: string | null
  /** Branch name (or null) — used when no PR exists yet. */
  branch?: string | null
}

/** Short SHA for display (first 7 chars). */
function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '—'
}

/** Freshness → dot color + at-a-glance label + native-tooltip detail. */
function freshnessView(freshness: PreviewFreshness | null): {
  dot: string
  label: string
  title: string
} {
  const previewSha = freshness?.previewSha ?? null
  const prHeadSha = freshness?.prHeadSha ?? null
  const shas = `preview ${short(previewSha)} · PR ${short(prHeadSha)}`

  switch (freshness?.status) {
    case 'UP_TO_DATE':
      return {
        dot: 'bg-green-500',
        label: 'à jour',
        title: `Preview à jour avec la PR (${shas})`,
      }
    case 'STALE': {
      const behind = freshness.behindBy
      const label =
        behind != null && behind > 0 ? `en retard de ${behind}` : 'en retard'
      const count =
        behind != null && behind > 0
          ? `en retard de ${behind} commit${behind > 1 ? 's' : ''}`
          : 'en retard sur la PR'
      return {
        dot: 'bg-amber-500',
        label,
        title: `Preview ${count} (${shas})`,
      }
    }
    case 'BUILDING':
      return {
        dot: 'bg-blue-500 animate-pulse',
        label: 'déploiement…',
        title: 'Déploiement de la preview en cours',
      }
    default:
      // NO_PREVIEW / UNKNOWN / null — URL is reachable but freshness is unknown.
      return {
        dot: 'bg-muted-foreground/40',
        label: 'preview',
        title: `Fraîcheur de la preview inconnue (${shas})`,
      }
  }
}

/**
 * Dedicated "open the preview" badge for the worktree header bar, with a
 * freshness dot telling whether the deployed preview matches the PR head.
 *
 * Surfaces the preview URL conveniently (a single click opens it) instead of
 * burying it in the Jenkins popover. Reuses `useJenkinsStatus` — the same query
 * key as `JenkinsStatusBadge`, so both share one fetch.
 *
 * Renders nothing until there is a preview URL to open.
 */
export function PreviewBadge({
  projectId,
  worktreeId,
  prId,
  branch,
}: PreviewBadgeProps) {
  const { data: status } = useJenkinsStatus(projectId, worktreeId, prId, branch)

  const previewUrl = status?.previewUrl ?? null
  const handleOpen = useCallback(() => {
    if (previewUrl) openUrl(previewUrl)
  }, [previewUrl])

  if (!previewUrl) return null

  const view = freshnessView(status?.previewFreshness ?? null)

  return (
    <button
      type="button"
      onClick={handleOpen}
      title={view.title}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs font-medium',
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
      )}
    >
      <Globe className="size-3.5" />
      <span className="hidden lg:inline">Preview</span>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', view.dot)} />
      <span className="hidden text-[11px] text-muted-foreground lg:inline">
        {view.label}
      </span>
    </button>
  )
}
