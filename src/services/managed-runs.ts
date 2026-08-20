import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listen, invoke } from '@/lib/transport'
import {
  prepareManagedTerminal,
  disposeTerminal,
} from '@/lib/terminal-instances'
import { queryClient } from '@/lib/query-client'
import { useTerminalStore } from '@/store/terminal-store'
import type { RunScriptEntry } from './projects'

export type ManagedRunStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'orphaned'

export interface ManagedRun {
  id: string
  projectId: string
  worktreeId: string
  terminalId: string
  scriptId: string
  command: string
  status: ManagedRunStatus
  basePort: number | null
  portCount: number
  pid: number | null
  startedAt: number
  stoppedAt: number | null
  exitCode: number | null
  error: string | null
}

export interface RunEnvironment {
  projectId: string
  worktreeId: string
  basePort: number | null
  portCount: number
}

export interface WorkspacePortAllocation {
  project_id: string
  worktree_id: string
  base_port: number
  port_count: number
  allocated_at: number
}

export const managedRunKeys = {
  project: (projectId: string) => ['managed-runs', projectId] as const,
}

export function useProjectRuns(projectId: string | null) {
  return useQuery({
    queryKey: managedRunKeys.project(projectId ?? ''),
    queryFn: () => invoke<ManagedRun[]>('get_project_runs', { projectId }),
    enabled: !!projectId,
    refetchInterval: query => {
      const runs = query.state.data
      return runs?.some(run =>
        ['starting', 'running', 'stopping'].includes(run.status)
      )
        ? 2_000
        : false
    },
  })
}

export function useManagedRunEvents() {
  const client = useQueryClient()
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listen<ManagedRun>('run:updated', event => {
      client.setQueryData<ManagedRun[]>(
        managedRunKeys.project(event.payload.projectId),
        current => {
          const runs = current ?? []
          const index = runs.findIndex(run => run.id === event.payload.id)
          if (index === -1) return [...runs, event.payload]
          const next = [...runs]
          next[index] = event.payload
          return next
        }
      )
    }).then(cleanup => {
      if (cancelled) cleanup()
      else unlisten = cleanup
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [client])
}

export async function startManagedRunForWorkspace(options: {
  projectId: string
  worktreeId: string
  worktreePath: string
  script: RunScriptEntry
}): Promise<ManagedRun> {
  const existingRuns = await invoke<ManagedRun[]>('get_project_runs', {
    projectId: options.projectId,
  })
  const existing = existingRuns.find(
    run =>
      run.worktreeId === options.worktreeId &&
      run.scriptId === options.script.id &&
      ['starting', 'running', 'stopping'].includes(run.status)
  )
  if (existing) {
    const run = await invoke<ManagedRun>('start_managed_run', {
      worktreeId: options.worktreeId,
      scriptId: options.script.id,
      terminalId: existing.terminalId,
      cols: 80,
      rows: 24,
    })
    useTerminalStore
      .getState()
      .setActiveTerminal(existing.worktreeId, existing.terminalId)
    queryClient.invalidateQueries({
      queryKey: managedRunKeys.project(options.projectId),
    })
    return run
  }

  const terminalId = useTerminalStore
    .getState()
    .addTerminal(
      options.worktreeId,
      options.script.command,
      options.script.label
    )
  await prepareManagedTerminal(terminalId, {
    worktreeId: options.worktreeId,
    worktreePath: options.worktreePath,
    command: options.script.command,
  })

  try {
    const run = await invoke<ManagedRun>('start_managed_run', {
      worktreeId: options.worktreeId,
      scriptId: options.script.id,
      terminalId,
      cols: 80,
      rows: 24,
    })
    if (run.terminalId !== terminalId) {
      disposeTerminal(terminalId)
      useTerminalStore.getState().removeTerminal(options.worktreeId, terminalId)
      useTerminalStore
        .getState()
        .setActiveTerminal(options.worktreeId, run.terminalId)
    }
    useTerminalStore.getState().setTerminalRunning(run.terminalId, true)
    queryClient.invalidateQueries({
      queryKey: managedRunKeys.project(options.projectId),
    })
    return run
  } catch (error) {
    disposeTerminal(terminalId)
    useTerminalStore.getState().removeTerminal(options.worktreeId, terminalId)
    throw error
  }
}

export function useStopWorkspaceRuns(projectId: string | null) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (worktreeId: string) =>
      invoke<ManagedRun[]>('stop_workspace_runs', { worktreeId }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: managedRunKeys.project(projectId ?? ''),
      }),
  })
}

export function useRunEnvironment(worktreeId: string | null) {
  return useQuery({
    queryKey: ['run-environment', worktreeId],
    queryFn: () =>
      invoke<RunEnvironment>('get_workspace_run_environment', { worktreeId }),
    enabled: !!worktreeId,
    staleTime: 30_000,
  })
}

export function useReallocateWorkspacePorts(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (worktreeId: string) =>
      invoke<WorkspacePortAllocation>('reallocate_workspace_ports', {
        worktreeId,
      }),
    onSuccess: (_, worktreeId) => {
      client.invalidateQueries({ queryKey: ['run-environment', worktreeId] })
      client.invalidateQueries({ queryKey: managedRunKeys.project(projectId) })
    },
  })
}
