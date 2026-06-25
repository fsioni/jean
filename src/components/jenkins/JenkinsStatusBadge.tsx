import { useCallback } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  CircleDashed,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Hourglass,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  useJenkinsStatus,
  useRerunJenkinsPipeline,
  useRestartJenkinsIntegration,
} from '@/services/jenkins'
import { JenkinsStageList, formatDuration } from './JenkinsStageList'
import type { JenkinsBuild, JenkinsWorktreeStatus } from '@/types/jenkins'

interface JenkinsStatusBadgeProps {
  projectId: string
  worktreeId: string
  /** GitHub PR number as a string (or null). */
  prId?: string | null
  /** Branch name (or null) — used when no PR exists yet. */
  branch?: string | null
}

/** Human "time in queue" since an epoch-ms timestamp. */
function formatSince(ms: number): string {
  const elapsed = Date.now() - ms
  if (!ms || elapsed < 0) return ''
  const min = Math.floor(elapsed / 60000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `depuis ${min} min`
  return `depuis ${Math.floor(min / 60)} h ${min % 60} min`
}

/** Visual treatment for the global build-and-test verdict. */
function overallBadge(status: string): {
  label: string
  icon: React.ReactNode
  text: string
  hover: string
} {
  switch (status) {
    case 'SUCCESS':
      return {
        label: 'Passing',
        icon: <CheckCircle2 className="size-3.5" />,
        text: 'text-green-600',
        hover: 'hover:bg-green-500/10',
      }
    case 'FAILURE':
      return {
        label: 'Failing',
        icon: <XCircle className="size-3.5" />,
        text: 'text-red-600',
        hover: 'hover:bg-red-500/10',
      }
    case 'BUILDING':
      return {
        label: 'Building',
        icon: <Loader2 className="size-3.5 animate-spin" />,
        text: 'text-blue-600',
        hover: 'hover:bg-blue-500/10',
      }
    case 'QUEUED':
      return {
        label: 'Queued',
        icon: <Hourglass className="size-3.5" />,
        text: 'text-amber-600',
        hover: 'hover:bg-amber-500/10',
      }
    default:
      return {
        label: 'Unknown',
        icon: <CircleDashed className="size-3.5" />,
        text: 'text-muted-foreground',
        hover: 'hover:bg-muted',
      }
  }
}

/** Icon for a build's OWN result — independent of the overall/queued state. */
function buildResultIcon(build: JenkinsBuild): React.ReactNode {
  if (build.building) {
    return <Loader2 className="size-3.5 animate-spin text-blue-600" />
  }
  switch (build.result) {
    case 'SUCCESS':
      return <CheckCircle2 className="size-3.5 text-green-600" />
    case null:
      return <CircleDashed className="size-3.5 text-muted-foreground" />
    default:
      return <XCircle className="size-3.5 text-red-600" />
  }
}

/** Whether the resolved status carries no real Jenkins data (hide the badge). */
function isUnconfigured(status: JenkinsWorktreeStatus): boolean {
  return (
    status.overallStatus === 'UNKNOWN' &&
    status.pipeline === null &&
    status.stages.length === 0 &&
    status.preview === null
  )
}

/**
 * Compact Jenkins verdict for a worktree, sized for the worktree header bar
 * (next to the git status / GitHub badges).
 *
 * The pill reflects the GLOBAL `build-and-test` result for the worktree's PR
 * (not any single stage). Clicking opens a popover with the per-stage breakdown
 * ("Integration tests" highlighted as the important flaky step) and actions
 * (re-run pipeline, restart integration tests). Preview access lives in the
 * dedicated `PreviewBadge` next to this one.
 *
 * Renders nothing when there is no PR/branch or Jenkins is not configured.
 */
export function JenkinsStatusBadge({
  projectId,
  worktreeId,
  prId,
  branch,
}: JenkinsStatusBadgeProps) {
  const { data: status } = useJenkinsStatus(projectId, worktreeId, prId, branch)

  const rerunPipeline = useRerunJenkinsPipeline()
  const restartIntegration = useRestartJenkinsIntegration()

  const handleRerun = useCallback(() => {
    rerunPipeline.mutate({ projectId, worktreeId, prId, branch })
  }, [rerunPipeline, projectId, worktreeId, prId, branch])

  const pipelineNumber = status?.pipeline?.number
  const handleRestartIntegration = useCallback(() => {
    if (pipelineNumber == null) return
    restartIntegration.mutate({
      projectId,
      worktreeId,
      buildNumber: pipelineNumber,
    })
  }, [restartIntegration, projectId, worktreeId, pipelineNumber])

  const handleOpenPipeline = useCallback(() => {
    if (status?.pipeline?.url) openUrl(status.pipeline.url)
  }, [status?.pipeline?.url])

  // Hide unless there's a real Jenkins verdict for this worktree.
  if (!status || isUnconfigured(status)) return null

  const badge = overallBadge(status.overallStatus)
  const pipeline = status.pipeline

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs font-medium transition-colors',
            badge.text,
            badge.hover
          )}
          title={`build-and-test : ${badge.label}`}
        >
          {badge.icon}
          <span className="hidden lg:inline">build-and-test</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3 font-sans text-sm">
        {/* Overall status — same verdict as the title-bar badge. */}
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs font-medium',
              badge.text
            )}
          >
            {badge.icon}
            {badge.label}
          </span>
        </div>

        {/* Queue (a NEW run waiting to start — e.g. serialized behind the lock) */}
        {status.queue && (
          <div className="mt-2 flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-500">
            <Hourglass className="mt-0.5 size-3 shrink-0" />
            <span className="min-w-0">
              {`En file d'attente ${formatSince(status.queue.sinceMs)}`}
              {status.queue.why ? ` — ${status.queue.why}` : ''}
            </span>
          </div>
        )}

        {/* The build the stages below belong to. When QUEUED this is the LAST
            finished run — distinct from the queued new run above. */}
        {pipeline && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">
              {pipeline.building ? 'Build en cours' : 'Dernier build'}
            </span>
            <span className="font-medium text-foreground">build-and-test</span>
            <button
              type="button"
              onClick={handleOpenPipeline}
              className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              #{pipeline.number}
              <ExternalLink className="h-3 w-3" />
            </button>
            {buildResultIcon(pipeline)}
            {pipeline.durationMs > 0 && (
              <span className="tabular-nums text-muted-foreground">
                {formatDuration(pipeline.durationMs)}
              </span>
            )}
          </div>
        )}

        {/* Stages (with the Integration tests retry attempts inline) */}
        {status.stages.length > 0 && (
          <div className="mt-2">
            <JenkinsStageList
              stages={status.stages}
              attempts={status.integrationAttempts}
            />
          </div>
        )}

        {/* Actions */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRerun}
            disabled={rerunPipeline.isPending}
            title={
              'Comments “retest this please” on the PR so ghprb re-triggers the ' +
              'pipeline (keeps the GitHub check in sync; starts within ~5 min).'
            }
          >
            {rerunPipeline.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Re-run pipeline
          </Button>

          {pipeline && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRestartIntegration}
              disabled={restartIntegration.isPending}
            >
              {restartIntegration.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Relancer Integration tests
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
