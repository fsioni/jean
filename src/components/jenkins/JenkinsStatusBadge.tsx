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
  FlaskConical,
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
import type { JenkinsStage, JenkinsWorktreeStatus } from '@/types/jenkins'

interface JenkinsStatusBadgeProps {
  projectId: string
  worktreeId: string
  /** GitHub PR number as a string (or null). */
  prId?: string | null
  /** Branch name (or null) — used when no PR exists yet. */
  branch?: string | null
}

const INTEGRATION_TESTS_STAGE = 'Integration tests'

/** Format a duration in ms as mm:ss. */
function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
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
    default:
      return {
        label: 'Unknown',
        icon: <CircleDashed className="size-3.5" />,
        text: 'text-muted-foreground',
        hover: 'hover:bg-muted',
      }
  }
}

/** Color for a per-stage status dot. */
function stageDotClass(status: string): string {
  switch (status) {
    case 'SUCCESS':
      return 'bg-green-500'
    case 'FAILED':
      return 'bg-red-500'
    case 'IN_PROGRESS':
      return 'bg-blue-500 animate-pulse'
    case 'ABORTED':
      return 'bg-amber-500'
    default:
      // NOT_EXECUTED and anything unknown
      return 'bg-muted-foreground/40'
  }
}

function StageRow({ stage }: { stage: JenkinsStage }) {
  const isIntegration = stage.name === INTEGRATION_TESTS_STAGE
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded px-1.5 py-1 text-xs',
        isIntegration && 'bg-muted/60 font-medium'
      )}
    >
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          stageDotClass(stage.status)
        )}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {stage.name}
        {isIntegration && (
          <FlaskConical className="ml-1 inline-block h-3 w-3 text-muted-foreground" />
        )}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatDuration(stage.durationMs)}
      </span>
    </div>
  )
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
 * (re-run pipeline, restart integration tests, open preview).
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

  const handleOpenPreview = useCallback(() => {
    if (status?.previewUrl) openUrl(status.previewUrl)
  }, [status?.previewUrl])

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
        {/* Header: global build-and-test verdict + link + duration */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn('inline-flex items-center gap-1 text-xs font-medium', badge.text)}
          >
            {badge.icon}
            {badge.label}
          </span>
          <span className="text-xs font-medium text-foreground">
            build-and-test
          </span>
          {pipeline && (
            <button
              type="button"
              onClick={handleOpenPipeline}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              #{pipeline.number}
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          {pipeline && pipeline.durationMs > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatDuration(pipeline.durationMs)}
            </span>
          )}
        </div>

        {/* Stages */}
        {status.stages.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {status.stages.map(stage => (
              <StageRow key={stage.name} stage={stage} />
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRerun}
            disabled={rerunPipeline.isPending}
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

          {status.previewUrl && (
            <Button variant="ghost" size="sm" onClick={handleOpenPreview}>
              <ExternalLink className="h-3.5 w-3.5" />
              Preview
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
