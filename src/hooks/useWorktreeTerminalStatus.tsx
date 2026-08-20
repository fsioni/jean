import { useMemo } from 'react'
import { Globe2, Loader2, Play, RefreshCw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { isPanelTerminal, useTerminalStore } from '@/store/terminal-store'
import { usePorts, useTerminalListeningPorts } from '@/services/projects'
import { resolvePortUrl } from '@/components/browser/default-tab-url'
import { openExternal } from '@/lib/platform'
import {
  useProjectRuns,
  useReallocateWorkspacePorts,
  useRunEnvironment,
  useStopWorkspaceRuns,
} from '@/services/managed-runs'
import type { TerminalPortInfo } from '@/services/projects'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Shared hook for per-worktree terminal status detection.
 * Tracks running/failed run-script terminals and discovered listening ports.
 */
export function useWorktreeTerminalStatus(
  worktreeId: string,
  projectId: string | null = null
) {
  const { data: managedRuns = [] } = useProjectRuns(projectId)
  const workspaceManagedRuns = managedRuns
    .filter(run => run.worktreeId === worktreeId)
    .sort((left, right) => right.startedAt - left.startedAt)
  const latestManagedRun = workspaceManagedRuns[0]
  const activeManagedRuns = workspaceManagedRuns.filter(run =>
    ['starting', 'running', 'stopping'].includes(run.status)
  )
  const managedRun =
    activeManagedRuns.find(run => run.status === 'stopping') ??
    activeManagedRuns[0]
  const lastManagedFailure =
    latestManagedRun && ['failed', 'orphaned'].includes(latestManagedRun.status)
      ? latestManagedRun
      : undefined
  const hasRunningTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(
      t => isPanelTerminal(t) && !!t.command && state.runningTerminals.has(t.id)
    )
  })
  const hasFailedTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(
      t => isPanelTerminal(t) && !!t.command && state.failedTerminals.has(t.id)
    )
  })
  const isManagedActive = !!managedRun
  const isManagedFailed = !!lastManagedFailure && !managedRun
  const showTerminalIndicator =
    hasRunningTerminal ||
    hasFailedTerminal ||
    isManagedActive ||
    isManagedFailed

  // Poll for listening ports only when terminals are running
  const { data: listeningPorts = [] } =
    useTerminalListeningPorts(hasRunningTerminal)

  // Build tooltip lines on demand via getState() — no subscription needed
  // for tooltip content (stale-by-one-render is fine for hover-only UI)
  const tooltipLines = useMemo(() => {
    if (!showTerminalIndicator) return null
    const { terminals, runningTerminals, failedTerminals } =
      useTerminalStore.getState()
    const worktreeTerminals = terminals[worktreeId] ?? []
    const lines: string[] = []
    if (activeManagedRuns.length > 0) {
      for (const run of activeManagedRuns) {
        const port = run.basePort ? ` — port ${run.basePort}` : ''
        lines.push(`${run.command} — ${run.status}${port}`)
      }
    } else if (lastManagedFailure) {
      lines.push(
        `${lastManagedFailure.command} — ${lastManagedFailure.status}${lastManagedFailure.error ? `: ${lastManagedFailure.error}` : ''}`
      )
    }
    for (const t of worktreeTerminals) {
      if (!isPanelTerminal(t)) continue
      if (!t.command) continue
      if (activeManagedRuns.some(run => run.terminalId === t.id)) continue
      if (runningTerminals.has(t.id)) {
        const ports = (listeningPorts as TerminalPortInfo[]).flatMap(p =>
          p.terminalId === t.id ? [`:${p.port}`] : []
        )
        const portSuffix = ports.length > 0 ? ` (${ports.join(', ')})` : ''
        lines.push(`${t.command}${portSuffix}`)
      } else if (failedTerminals.has(t.id)) {
        lines.push(`${t.command} (crashed)`)
      }
    }
    return lines
  }, [
    showTerminalIndicator,
    worktreeId,
    listeningPorts,
    activeManagedRuns,
    lastManagedFailure,
  ])

  return {
    hasRunningTerminal,
    hasFailedTerminal,
    showTerminalIndicator,
    tooltipLines,
    activeManagedRuns,
    managedStatus: managedRun?.status ?? lastManagedFailure?.status ?? null,
  }
}

/**
 * Terminal status indicator with tooltip showing running/failed status and listening ports.
 * Running: yellow square-spinner (original style). Failed: red square.
 * Returns null when no run-script terminals are active or failed.
 */
export function TerminalStatusIndicator({
  worktreeId,
  projectId = null,
  iconSize = 'h-2.5 w-2.5',
  showStopButton = false,
}: {
  worktreeId: string
  projectId?: string | null
  iconSize?: string
  showStopButton?: boolean
}) {
  const {
    hasFailedTerminal,
    showTerminalIndicator,
    tooltipLines,
    activeManagedRuns,
    managedStatus,
  } = useWorktreeTerminalStatus(worktreeId, projectId)
  const stopWorkspaceRuns = useStopWorkspaceRuns(projectId)

  if (!showTerminalIndicator || !tooltipLines) return null

  const isTransitioning =
    managedStatus === 'starting' || managedStatus === 'stopping'
  const indicator = isTransitioning ? (
    <Loader2 className={cn('shrink-0 animate-spin text-amber-500', iconSize)} />
  ) : (
    <Play
      className={cn(
        'shrink-0 fill-none',
        iconSize,
        hasFailedTerminal ||
          managedStatus === 'failed' ||
          managedStatus === 'orphaned'
          ? 'text-red-500'
          : 'text-amber-500 dark:text-yellow-400 animate-icon-glow'
      )}
    />
  )

  return (
    <span className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>{indicator}</TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-col gap-0.5">
            {tooltipLines.map(line => (
              <span key={line} className="text-xs">
                {line}
              </span>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
      {showStopButton && activeManagedRuns.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[10px] text-muted-foreground"
          disabled={
            activeManagedRuns.every(run => run.status === 'stopping') ||
            stopWorkspaceRuns.isPending
          }
          onClick={event => {
            event.stopPropagation()
            stopWorkspaceRuns.mutate(worktreeId, {
              onError: error => toast.error(`Failed to stop run: ${error}`),
            })
          }}
        >
          {activeManagedRuns.every(run => run.status === 'stopping') ||
          stopWorkspaceRuns.isPending ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Square className="h-2.5 w-2.5" />
          )}
          Stop
        </Button>
      )}
    </span>
  )
}

export function WorkspacePortBadge({
  worktreeId,
  projectId,
  worktreePath,
}: {
  worktreeId: string
  projectId: string
  worktreePath: string
}) {
  const { data: environment } = useRunEnvironment(worktreeId)
  const { data: ports = [] } = usePorts(worktreePath)
  const { data: managedRuns = [] } = useProjectRuns(projectId)
  const reallocate = useReallocateWorkspacePorts(projectId)
  if (!environment?.basePort || environment.portCount < 1) return null

  const lastPort = environment.basePort + environment.portCount - 1
  const runIsReady = managedRuns.some(
    run => run.worktreeId === worktreeId && run.status === 'running'
  )
  const openPort = (port: (typeof ports)[number]) => {
    void openExternal(resolvePortUrl(port))
  }
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="rounded border border-border/60 bg-muted/40 px-1 py-0.5 font-mono text-[9px] font-normal text-muted-foreground">
            :{environment.basePort}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-0.5 text-xs">
            <p>
              Allocated ports: {environment.basePort}–{lastPort}
            </p>
            <p className="font-mono">JEAN_PORT={environment.basePort}</p>
            <p className="font-mono">JEAN_PORT_COUNT={environment.portCount}</p>
          </div>
        </TooltipContent>
      </Tooltip>
      {ports.length === 1 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
              aria-label={`Open ${ports[0]?.label ?? 'app'} in default browser`}
              disabled={!runIsReady}
              onClick={event => {
                event.stopPropagation()
                const port = ports[0]
                if (port) openPort(port)
              }}
            >
              <Globe2 className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {runIsReady
              ? `Open ${ports[0]?.label ?? 'app'} in default browser`
              : 'Start the Run to open this app'}
          </TooltipContent>
        </Tooltip>
      )}
      {ports.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
              aria-label="Open app port in default browser"
              title={
                runIsReady
                  ? 'Open app port in default browser'
                  : 'Start the Run to open this app'
              }
              disabled={!runIsReady}
              onClick={event => event.stopPropagation()}
            >
              <Globe2 className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            onClick={event => event.stopPropagation()}
          >
            <DropdownMenuLabel>Open in default browser</DropdownMenuLabel>
            {ports.map(port => (
              <DropdownMenuItem
                key={`${port.label}-${port.port}`}
                onSelect={() => openPort(port)}
              >
                <span className="min-w-0 flex-1 truncate">{port.label}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  :{port.port}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-muted-foreground group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="Reallocate workspace ports"
            disabled={reallocate.isPending}
            onClick={event => {
              event.stopPropagation()
              reallocate.mutate(worktreeId, {
                onError: error =>
                  toast.error('Could not reallocate ports', {
                    description: String(error),
                  }),
              })
            }}
          >
            <RefreshCw
              className={cn(
                'h-2.5 w-2.5',
                reallocate.isPending && 'animate-spin'
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>Reallocate ports (Run must be stopped)</TooltipContent>
      </Tooltip>
    </span>
  )
}
