/**
 * Jenkins integration service.
 *
 * Mirrors the style of `src/services/github.ts` (TanStack Query + sonner) and
 * `src/services/git-status.ts` (event-driven cache updates).
 *
 * Backend contract:
 * - get_jenkins_status({ projectId, worktreeId, prId?, branch? }) -> JenkinsWorktreeStatus
 * - save_jenkins_config({ projectId, url, user, token, previewUrlTemplate? }) -> Project
 * - rerun_jenkins_pipeline({ projectId, prId?, branch? }) -> void
 * - restart_jenkins_integration({ projectId, buildNumber }) -> void
 * - event "jenkins:status-update" -> JenkinsWorktreeStatus
 */

import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  invoke,
  listen,
  useWsConnectionStatus,
  type UnlistenFn,
} from '@/lib/transport'
import { logger } from '@/lib/logger'
import { isTauri } from '@/services/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

function getErrorMessage(error: unknown): string {
  if (!error) return ''
  return error instanceof Error ? error.message : String(error)
}

/**
 * The backend signals an unconfigured project with a "Jenkins not configured"
 * error. That is an expected state (no URL/user/token saved yet), not a
 * failure, so we keep it silent and surface a usable "not configured" status.
 */
export function isJenkinsNotConfiguredError(error: unknown): boolean {
  return getErrorMessage(error).toLowerCase().includes('not configured')
}

/** Sentinel status returned when Jenkins is not configured for the project. */
function notConfiguredStatus(
  worktreeId: string,
  prId: string | null
): JenkinsWorktreeStatus {
  return {
    worktreeId,
    prId,
    pipeline: null,
    stages: [],
    preview: null,
    previewUrl: null,
    previewFreshness: null,
    queue: null,
    overallStatus: 'UNKNOWN',
    checkedAt: Math.floor(Date.now() / 1000),
  }
}

// ============================================================================
// Query Keys
// ============================================================================

export const jenkinsQueryKeys = {
  all: ['jenkins'] as const,
  status: (worktreeId: string) =>
    [...jenkinsQueryKeys.all, 'status', worktreeId] as const,
}

// ============================================================================
// Status Query
// ============================================================================

/**
 * Hook to fetch the Jenkins status for a worktree.
 *
 * Enabled only when a project + worktree are present AND we have something to
 * key on (a PR id or a branch). Returns a "not configured" sentinel instead of
 * throwing when Jenkins is not set up for the project, so callers can simply
 * render nothing.
 *
 * @param projectId - The project ID
 * @param worktreeId - The worktree ID
 * @param prId - GitHub PR number as a string (or null)
 * @param branch - Branch name (or null) — used when no PR exists yet
 */
export function useJenkinsStatus(
  projectId: string | null,
  worktreeId: string | null,
  prId?: string | null,
  branch?: string | null,
  options?: { enabled?: boolean; staleTime?: number }
) {
  const hasTarget = !!prId || !!branch
  const enabled =
    (options?.enabled ?? true) && !!projectId && !!worktreeId && hasTarget

  return useQuery({
    queryKey: jenkinsQueryKeys.status(worktreeId ?? ''),
    queryFn: async (): Promise<JenkinsWorktreeStatus> => {
      if (!isTauri() || !projectId || !worktreeId) {
        return notConfiguredStatus(worktreeId ?? '', prId ?? null)
      }

      try {
        logger.debug('Fetching Jenkins status', {
          projectId,
          worktreeId,
          prId,
          branch,
        })
        const status = await invoke<JenkinsWorktreeStatus>(
          'get_jenkins_status',
          {
            projectId,
            worktreeId,
            prId: prId ?? null,
            branch: branch ?? null,
          }
        )
        return status
      } catch (error) {
        // Unconfigured Jenkins is an expected, silent state.
        if (isJenkinsNotConfiguredError(error)) {
          logger.debug('Jenkins not configured', { projectId, worktreeId })
          return notConfiguredStatus(worktreeId, prId ?? null)
        }
        logger.error('Failed to load Jenkins status', {
          error,
          projectId,
          worktreeId,
        })
        throw error
      }
    },
    enabled,
    staleTime: options?.staleTime ?? 1000 * 60, // 60 seconds
    gcTime: 1000 * 60 * 5, // 5 minutes
    retry: 1,
  })
}

/**
 * Cache-only read of a worktree's Jenkins status — **never fetches**.
 *
 * The global poller (`jenkins::start_poller`) already broadcasts every PR-linked
 * worktree's status every 60s; `useJenkinsStatusEvents()` writes those payloads
 * into the same query key via `setQueryData`. List rows consume that cache
 * passively: subscribing here re-renders the row when a fresh status lands,
 * with zero extra `get_jenkins_status` invocations (which would be N redundant
 * fetches at mount + every cycle).
 *
 * Returns `undefined` until the poller has populated the cache for this worktree.
 */
export function useJenkinsStatusCached(worktreeId: string | null) {
  return useQuery<JenkinsWorktreeStatus>({
    queryKey: jenkinsQueryKeys.status(worktreeId ?? ''),
    // Never invoked: enabled is false. The cache is filled by the poller events.
    queryFn: () => {
      throw new Error('useJenkinsStatusCached is cache-only')
    },
    enabled: false,
    staleTime: Infinity,
    gcTime: 1000 * 60 * 5,
  })
}

// ============================================================================
// Status Events
// ============================================================================

/**
 * Hook to listen for `jenkins:status-update` events from the backend and push
 * the payload into the TanStack Query cache (keyed by worktree id).
 *
 * Follows the `useGitStatusEvents` pattern in `git-status.ts`, including the
 * unlisten cleanup on unmount and re-subscription when the WS connection
 * changes.
 */
export function useJenkinsStatusEvents() {
  const queryClient = useQueryClient()
  const wsConnected = useWsConnectionStatus()

  useEffect(() => {
    if (!isTauri()) return

    const unlistenPromises: Promise<UnlistenFn>[] = []

    unlistenPromises.push(
      listen<JenkinsWorktreeStatus>('jenkins:status-update', event => {
        const status = event.payload
        if (!status?.worktreeId) return
        queryClient.setQueryData(
          jenkinsQueryKeys.status(status.worktreeId),
          status
        )
      })
    )

    const unlistens: UnlistenFn[] = []
    Promise.all(unlistenPromises).then(fns => {
      unlistens.push(...fns)
    })

    return () => {
      unlistens.forEach(unlisten => unlisten())
    }
  }, [queryClient, wsConnected])
}

// ============================================================================
// Mutations
// ============================================================================

/**
 * Mutation to re-run the full Jenkins pipeline for a PR / branch.
 * Invalidates the worktree's Jenkins status on success.
 */
export function useRerunJenkinsPipeline() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (variables: {
      projectId: string
      /** Only used to invalidate the right status cache entry. */
      worktreeId: string
      prId?: string | null
      branch?: string | null
    }): Promise<void> => {
      if (!isTauri()) throw new Error('Not in Tauri context')
      await invoke('rerun_jenkins_pipeline', {
        projectId: variables.projectId,
        prId: variables.prId ?? null,
        branch: variables.branch ?? null,
      })
    },
    onMutate: () => {
      const toastId = toast.loading('Re-running Jenkins pipeline...')
      return { toastId }
    },
    onSuccess: (_data, variables, context) => {
      toast.success('Jenkins pipeline triggered', { id: context?.toastId })
      queryClient.invalidateQueries({
        queryKey: jenkinsQueryKeys.status(variables.worktreeId),
      })
    },
    onError: (error, _variables, context) => {
      toast.error(`Failed to re-run pipeline: ${getErrorMessage(error)}`, {
        id: context?.toastId,
      })
    },
  })
}

/**
 * Mutation to restart only the integration tests for a given build.
 * Invalidates the worktree's Jenkins status on success.
 */
export function useRestartJenkinsIntegration() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (variables: {
      projectId: string
      /** Only used to invalidate the right status cache entry. */
      worktreeId: string
      buildNumber: number
    }): Promise<void> => {
      if (!isTauri()) throw new Error('Not in Tauri context')
      await invoke('restart_jenkins_integration', {
        projectId: variables.projectId,
        buildNumber: variables.buildNumber,
      })
    },
    onMutate: () => {
      const toastId = toast.loading('Restarting integration tests...')
      return { toastId }
    },
    onSuccess: (_data, variables, context) => {
      toast.success('Integration tests restarted', { id: context?.toastId })
      queryClient.invalidateQueries({
        queryKey: jenkinsQueryKeys.status(variables.worktreeId),
      })
    },
    onError: (error, _variables, context) => {
      toast.error(
        `Failed to restart integration tests: ${getErrorMessage(error)}`,
        { id: context?.toastId }
      )
    },
  })
}
