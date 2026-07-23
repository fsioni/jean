import { useCallback, useEffect, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitPullRequestArrow,
  Hourglass,
  Loader2,
  RefreshCw,
  Stethoscope,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { clickUpTaskIdFromBranch, clickupTaskUrl } from '@/lib/clickup'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import { Button } from '@/components/ui/button'
import { JenkinsStatusBadge } from '@/components/jenkins/JenkinsStatusBadge'
import { PreviewBadge } from '@/components/jenkins/PreviewBadge'
import {
  JenkinsStageList,
  formatDuration,
} from '@/components/jenkins/JenkinsStageList'
import { FailureReportPanel } from '@/components/jenkins/FailureReportPanel'
import { useRerunJenkinsPipeline } from '@/services/jenkins'
import { useGitStatus } from '@/services/git-status'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { JenkinsStage } from '@/types/jenkins'
import { PIPELINE_JOB } from '@/components/jenkins/jenkins-jobs'
import type { MissionControlRow as Row } from './useMissionControlRows'

/** Re-render every second while `active`, so the running clock ticks smoothly. */
function useElapsedTick(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

/** Last build duration, or live elapsed time while building. */
function pipelineDuration(row: Row): { text: string; live: boolean } | null {
  const pipeline = row.status?.pipeline
  if (!pipeline) return null
  if (pipeline.building) {
    return {
      text: formatDuration(Date.now() - pipeline.timestampMs),
      live: true,
    }
  }
  if (pipeline.durationMs > 0) {
    return { text: formatDuration(pipeline.durationMs), live: false }
  }
  return null
}

/** "8 min" — how long the item has been waiting in the Jenkins queue. */
function formatWait(sinceMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - sinceMs) / 60000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
}

/** Compact "where is the run" summary while building (colorblind-safe text). */
function stageProgress(
  stages: JenkinsStage[]
): { label: string; index: number; total: number } | null {
  if (stages.length === 0) return null
  const total = stages.length
  const runningIdx = stages.findIndex(s => s.status === 'IN_PROGRESS')
  const running = runningIdx >= 0 ? stages[runningIdx] : undefined
  if (running) {
    return { label: running.name, index: runningIdx + 1, total }
  }
  const done = stages.filter(
    s =>
      s.status === 'SUCCESS' || s.status === 'FAILED' || s.status === 'ABORTED'
  ).length
  return { label: 'étapes', index: done, total }
}

/**
 * One PR row in the Mission Control list. Identity on the left; the existing
 * Jenkins/Preview badges (verdict + popovers for re-run, restart integration,
 * open preview), an inline Re-run shortcut for failures and an "open in Jean"
 * action on the right.
 *
 * The per-stage breakdown is shown INLINE (no need to open Jenkins): expandable
 * via the chevron, and auto-expanded while a run is in progress so the stages
 * unfold live as the poller refreshes (~every 12s while building). A 1s ticker
 * keeps the running clock smooth.
 */
export function MissionControlRow({ row }: { row: Row }) {
  const { project, worktree, prId, status } = row
  const rerun = useRerunJenkinsPipeline()

  const pipeline = status?.pipeline ?? null
  const building = !!pipeline?.building
  const stages = status?.stages ?? []
  const hasStages = stages.length > 0
  const isFailure = status?.overallStatus === 'FAILURE'
  const queue = status?.queue ?? null
  // Commits on origin/<base> this branch doesn't have — i.e. "rebase me".
  // Live git status first, persisted cache as the fallback (same precedence as
  // `WorktreeItem` / the project canvas).
  const { data: gitStatus } = useGitStatus(worktree.id)
  const behind = gitStatus?.behind_count ?? worktree.cached_behind_count ?? 0

  // The queue wait ticks like the build clock does.
  useElapsedTick(building || !!queue)
  const duration = pipelineDuration(row)
  const progress = building ? stageProgress(stages) : null

  // Auto-expand when a run STARTS (rising edge), but respect a manual collapse.
  const [expanded, setExpanded] = useState(building)
  const prevBuilding = useRef(building)
  useEffect(() => {
    if (building && !prevBuilding.current) setExpanded(true)
    prevBuilding.current = building
  }, [building])

  const toggleExpanded = useCallback(() => setExpanded(e => !e), [])

  // A detached row has no `pr_url` on the worktree yet (Jean's link is being
  // repaired in the background) — fall back to the PR we detected by branch.
  const prUrl = worktree.pr_url ?? row.detectedPr?.url ?? null
  const handleOpenPr = useCallback(() => {
    if (prUrl) openUrl(prUrl)
  }, [prUrl])

  const clickUpId = clickUpTaskIdFromBranch(worktree.branch)
  const handleOpenClickUp = useCallback(() => {
    if (clickUpId) openUrl(clickupTaskUrl(clickUpId))
  }, [clickUpId])

  const handleOpenBuild = useCallback(() => {
    if (pipeline?.url) openUrl(pipeline.url)
  }, [pipeline?.url])

  const handleRerun = useCallback(() => {
    rerun.mutate({
      projectId: project.id,
      worktreeId: worktree.id,
      prId,
      branch: worktree.branch,
    })
  }, [rerun, project.id, worktree.id, worktree.branch, prId])

  // Navigate to the worktree's project canvas (closes Mission Control).
  const handleOpenInJean = useCallback(() => {
    useUIStore.getState().setMissionControlOpen(false)
    useChatStore.getState().clearActiveWorktree()
    const { selectProject, expandProject, selectWorktree } =
      useProjectsStore.getState()
    selectProject(project.id)
    expandProject(project.id)
    selectWorktree(worktree.id)
  }, [project.id, worktree.id])

  return (
    <div className="border-b border-border/60 transition-colors hover:bg-muted/40">
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Expand toggle (stages to show, or a failure to diagnose) */}
        {hasStages || isFailure ? (
          <button
            type="button"
            onClick={toggleExpanded}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={expanded ? 'Replier les étapes' : 'Déplier les étapes'}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {/* Identity */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="truncate font-medium text-foreground">
              {worktree.name}
            </span>
            <span className="shrink-0 text-muted-foreground">·</span>
            <span className="truncate text-xs text-muted-foreground">
              {project.name}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono">{worktree.branch}</span>
            {prUrl && (
              <button
                type="button"
                onClick={handleOpenPr}
                className="inline-flex shrink-0 items-center gap-0.5 transition-colors hover:text-foreground"
                title={
                  row.kind === 'detached'
                    ? 'PR trouvée sur cette branche — Jean la rattache en arrière-plan'
                    : 'Ouvrir la PR sur GitHub'
                }
              >
                #{prId}
                {row.kind === 'detached' && ' (détectée)'}
                <ExternalLink className="size-3" />
              </button>
            )}
            {row.kind === 'no-pr' && (
              <span className="shrink-0 italic" title="Aucune PR ouverte sur cette branche — Jenkins ne build que les PR">
                pas de PR
              </span>
            )}
            {clickUpId && (
              <button
                type="button"
                onClick={handleOpenClickUp}
                className="inline-flex shrink-0 items-center gap-0.5 transition-colors hover:text-foreground"
                title="Ouvrir le ticket ClickUp"
              >
                <ClickUpIcon className="size-3" />
                ClickUp
              </button>
            )}
            {/* Is the base branch already in this branch, or is a rebase due?
                Stated in words + icon — never by color alone. */}
            {behind > 0 && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 font-medium text-amber-700 dark:text-amber-500"
                title={`Cette branche est ${behind} commit(s) derrière ${worktree.base_branch ?? 'la branche de base'} — un rebase est conseillé avant de se fier au pipeline`}
              >
                <GitPullRequestArrow className="size-3" />À rebase · {behind}
              </span>
            )}
          </div>
        </div>

        {/* Waiting in the Jenkins queue: rank + wait, so the global queue never
            has to be opened to know whether the build is next or buried. */}
        {queue && (
          <span
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-500"
            title={
              queue.why
                ? `En file d'attente — ${queue.why}`
                : "En file d'attente Jenkins"
            }
          >
            <Hourglass className="size-3" />
            <span className="tabular-nums">
              {queue.position}/{queue.total}
            </span>
            <span className="hidden tabular-nums md:inline">
              · {formatWait(queue.sinceMs)}
            </span>
          </span>
        )}

        {/* Live stage progress while building (text-based: no color-only cue) */}
        {progress && (
          <span
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400"
            title="Étape en cours du pipeline"
          >
            <Loader2 className="size-3 animate-spin" />
            <span className="hidden max-w-[160px] truncate md:inline">
              {progress.label}
            </span>
            <span className="tabular-nums">
              {progress.index}/{progress.total}
            </span>
          </span>
        )}

        {/* Duration */}
        {duration && (
          <span
            className={cn(
              'shrink-0 tabular-nums text-xs text-muted-foreground',
              duration.live && 'text-blue-600 dark:text-blue-400'
            )}
            title={
              duration.live
                ? 'Durée écoulée (en cours)'
                : 'Durée du dernier build'
            }
          >
            {duration.text}
          </span>
        )}

        {/* Status + actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          <JenkinsStatusBadge
            projectId={project.id}
            worktreeId={worktree.id}
            prId={prId}
            branch={worktree.branch}
          />
          <PreviewBadge
            projectId={project.id}
            worktreeId={worktree.id}
            prId={prId}
            branch={worktree.branch}
          />
          {isFailure && (
            <Button
              variant="outline"
              size="sm"
              onClick={toggleExpanded}
              title="Voir la cause de l'échec (stage, tests, log) sans ouvrir Jenkins"
            >
              <Stethoscope className="size-3.5" />
              Pourquoi&nbsp;?
            </Button>
          )}
          {isFailure && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRerun}
              disabled={rerun.isPending}
              title="Re-run du pipeline (comment ghprb « retest this please »)"
            >
              {rerun.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Re-run
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenInJean}
            title="Ouvrir dans Jean"
          >
            <ArrowUpRight className="size-3.5" />
            <span className="hidden lg:inline">Ouvrir</span>
          </Button>
        </div>
      </div>

      {/* Inline stage timeline — the Jenkins-like breakdown, no tab to keep open */}
      {expanded && (hasStages || isFailure) && (
        <div className="px-3 pb-2.5 pl-9">
          {hasStages && (
            <JenkinsStageList
              stages={stages}
              attempts={status?.integrationAttempts ?? []}
            />
          )}

          {/* Why it broke: fetched only once this section is actually open. */}
          {isFailure && (
            <FailureReportPanel
              project={project}
              worktree={worktree}
              prId={prId}
              buildNumber={pipeline?.number ?? null}
            />
          )}

          {pipeline?.url && (
            <button
              type="button"
              onClick={handleOpenBuild}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              title="Ouvrir le build sur Jenkins"
            >
              {PIPELINE_JOB} #{pipeline.number}
              <ExternalLink className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
