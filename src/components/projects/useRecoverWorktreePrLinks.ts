import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import {
  isBaseSession,
  type DetectPrResponse,
  type Worktree,
} from '@/types/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'
import { jenkinsQueryKeys } from '@/services/jenkins'
import { isTauri, projectsQueryKeys } from '@/services/projects'

const RETRY_INTERVAL_MS = 60_000

/** Recover PRs created outside Jean after their worktree was already opened. */
export function useRecoverWorktreePrLinks(
  projectId: string,
  worktrees: Worktree[]
) {
  const queryClient = useQueryClient()
  const lastAttempt = useRef(new Map<string, number>())
  const inFlight = useRef(new Set<string>())

  useEffect(() => {
    if (!isTauri()) return

    const recover = () => {
      const now = Date.now()
      for (const worktree of worktrees) {
        if (
          isBaseSession(worktree) ||
          worktree.pr_number != null ||
          worktree.archived_at != null ||
          worktree.status === 'pending' ||
          worktree.status === 'deleting' ||
          !worktree.path ||
          inFlight.current.has(worktree.id) ||
          now - (lastAttempt.current.get(worktree.id) ?? -RETRY_INTERVAL_MS) <
            RETRY_INTERVAL_MS
        )
          continue

        lastAttempt.current.set(worktree.id, now)
        inFlight.current.add(worktree.id)
        void invoke<DetectPrResponse | null>('detect_and_link_pr', {
          worktreeId: worktree.id,
          worktreePath: worktree.path,
        })
          .then(async result => {
            if (result) {
              await queryClient.invalidateQueries({
                queryKey: projectsQueryKeys.worktrees(projectId),
              })
              // Populate the cache-only row immediately, not at the next poll.
              try {
                const status = await invoke<JenkinsWorktreeStatus>(
                  'get_jenkins_status',
                  {
                    projectId,
                    worktreeId: worktree.id,
                    prId: String(result.pr_number),
                    branch: worktree.branch,
                  }
                )
                queryClient.setQueryData(
                  jenkinsQueryKeys.status(worktree.id),
                  status
                )
              } catch {
                // The poller will still fill this cache on its next cycle.
              }
            }
          })
          .catch(() => {
            // Best effort: a missing gh login or network failure retries later.
          })
          .finally(() => inFlight.current.delete(worktree.id))
      }
    }

    recover()
    window.addEventListener('focus', recover)
    const interval = window.setInterval(recover, RETRY_INTERVAL_MS)
    return () => {
      window.removeEventListener('focus', recover)
      window.clearInterval(interval)
    }
  }, [projectId, queryClient, worktrees])
}
