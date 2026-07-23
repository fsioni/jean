import { useCallback } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useJenkinsStatus } from '@/services/jenkins'
import type { JenkinsWorktreeStatus, PreviewFreshness } from '@/types/jenkins'

interface PreviewBadgeProps {
  projectId: string
  worktreeId: string
  /** GitHub PR number as a string (or null). */
  prId?: string | null
  /** Branch name (or null) — used when no PR exists yet. */
  branch?: string | null
}

/** Pipeline stage that deploys the preview. */
const DEPLOY_PREVIEW_STAGE = 'Deploy preview'

/** Short SHA for display (first 7 chars). */
function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : '—'
}

/** Whether the preview is currently (re)deploying — the deploy stage is running. */
function isDeploying(status: JenkinsWorktreeStatus | undefined): boolean {
  return (
    status?.stages?.some(
      s => s.name === DEPLOY_PREVIEW_STAGE && s.status === 'IN_PROGRESS'
    ) ?? false
  )
}

/** "en retard de N commits" when known, else a generic stale phrasing. */
function behindText(behindBy: number | null | undefined): string {
  return behindBy != null && behindBy > 0
    ? `en retard de ${behindBy} commit${behindBy > 1 ? 's' : ''}`
    : 'en retard sur la PR'
}

/**
 * The commit comes from Jenkins (last successful deploy), not from the preview
 * itself: it says what was *deployed*, not what is *served*. Happens when the
 * preview answers `/version` with a 404 — the compose-based deploys don't
 * publish it.
 */
function isDeployedOnly(freshness: PreviewFreshness | null): boolean {
  return freshness?.shaSource === 'jenkins'
}

interface FreshnessView {
  dot: string
  /** Short label shown inline in the badge (empty = dot only). */
  label: string
  /** Full sentence shown in the popover. */
  statusLabel: string
}

/** Freshness (+ deploy-in-progress override) → dot color + labels. */
function freshnessView(
  freshness: PreviewFreshness | null,
  deploying: boolean
): FreshnessView {
  if (deploying) {
    return {
      dot: 'bg-blue-500 animate-pulse',
      label: 'déploiement…',
      statusLabel: 'Déploiement de la preview en cours',
    }
  }

  switch (freshness?.status) {
    case 'UP_TO_DATE':
      return {
        dot: 'bg-green-500',
        label: 'à jour',
        statusLabel: 'Preview à jour avec la PR',
      }
    case 'STALE':
      return {
        dot: 'bg-amber-500',
        label: 'périmée',
        statusLabel: `Preview périmée — ${behindText(freshness.behindBy)}`,
      }
    case 'DOWN':
      return {
        dot: 'bg-red-500',
        label: 'hors ligne',
        statusLabel: 'Preview hors ligne (injoignable)',
      }
    default:
      // UNKNOWN / null — reachable but no SHA to compare (e.g. PR head unknown).
      // No inline label: the dot alone avoids a redundant "Preview · preview".
      return {
        dot: 'bg-muted-foreground/40',
        label: '',
        statusLabel: 'Fraîcheur de la preview inconnue',
      }
  }
}

/**
 * Dedicated "open the preview" badge for the worktree header bar, with a
 * freshness dot telling whether the deployed preview matches the PR head.
 *
 * Clicking opens a popover with the freshness detail (deployed commit vs PR
 * head, commits behind) and an "open preview" action — disabled when the preview
 * is offline. Reuses `useJenkinsStatus` — the same query key as
 * `JenkinsStatusBadge`, so both share one fetch.
 *
 * Freshness comes from probing the preview's `/version` endpoint backend-side;
 * "déploiement…" is derived here from the live `Deploy preview` pipeline stage.
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

  const freshness = status?.previewFreshness ?? null
  const deploying = isDeploying(status)
  const view = freshnessView(freshness, deploying)

  const previewSha = freshness?.previewSha ?? null
  const prHeadSha = freshness?.prHeadSha ?? null
  const hasShas = previewSha != null || prHeadSha != null
  const isStale = !deploying && freshness?.status === 'STALE'
  // Don't offer to open a preview that is offline (and not mid-deploy).
  const offline = !deploying && freshness?.status === 'DOWN'
  // Keep the tooltip honest when the commit is Jenkins-sourced.
  const deployedOnly = !deploying && isDeployedOnly(freshness)
  const statusLabel = deployedOnly
    ? `${view.statusLabel} (d'après Jenkins)`
    : view.statusLabel

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={statusLabel}
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs font-medium',
            'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
          )}
        >
          <Globe className="size-3.5" />
          <span className="hidden lg:inline">Preview</span>
          <span className={cn('h-2 w-2 shrink-0 rounded-full', view.dot)} />
          {view.label && (
            <span className="hidden text-[11px] text-muted-foreground lg:inline">
              {view.label}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3 font-sans text-sm">
        {/* Status */}
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', view.dot)} />
          <span className="font-medium text-foreground">{statusLabel}</span>
        </div>

        {/* Deployed commit vs PR head */}
        {hasShas && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {deployedOnly ? 'Déployé' : 'Preview'}&nbsp;
              <span className="font-mono text-foreground">
                {short(previewSha)}
              </span>
            </span>
            <span>
              PR&nbsp;
              <span className="font-mono text-foreground">
                {short(prHeadSha)}
              </span>
            </span>
          </div>
        )}

        {deployedOnly && (
          <div className="mt-1 text-xs text-muted-foreground">
            La preview ne publie pas <code>/version</code> — commit du dernier
            déploiement Jenkins, pas forcément celui servi.
          </div>
        )}

        {isStale && (
          <div className="mt-1 text-xs text-amber-600 dark:text-amber-500">
            {behindText(freshness?.behindBy)}
          </div>
        )}

        {/* Open action — disabled when the preview is offline. */}
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleOpen}
            disabled={offline}
            title={offline ? 'Preview hors ligne' : undefined}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Ouvrir la preview
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
