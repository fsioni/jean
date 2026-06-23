import { useCallback, useEffect, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
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
import { useRerunJenkinsPipeline } from '@/services/jenkins'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { JenkinsStage } from '@/types/jenkins'
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

  useElapsedTick(building)
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

  const handleOpenPr = useCallback(() => {
    if (worktree.pr_url) openUrl(worktree.pr_url)
  }, [worktree.pr_url])

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
        {/* Expand toggle (only when there are stages to show) */}
        {hasStages ? (
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
            {worktree.pr_url && (
              <button
                type="button"
                onClick={handleOpenPr}
                className="inline-flex shrink-0 items-center gap-0.5 transition-colors hover:text-foreground"
                title="Ouvrir la PR sur GitHub"
              >
                #{prId}
                <ExternalLink className="size-3" />
              </button>
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
          </div>
        </div>

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
      {expanded && hasStages && (
        <div className="px-3 pb-2.5 pl-9">
          <JenkinsStageList stages={stages} />
          {pipeline?.url && (
            <button
              type="button"
              onClick={handleOpenBuild}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              title="Ouvrir le build sur Jenkins"
            >
              build-and-test #{pipeline.number}
              <ExternalLink className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
