/**
 * Cross-project aggregation for the Jenkins "Mission Control" view.
 *
 * Lists every PR-linked worktree across every Jenkins-configured project, joined
 * with the worktree's Jenkins status, sorted by urgency (failures first).
 *
 * Reads the SAME poller-fed cache the worktree rows use (`jenkinsQueryKeys`),
 * via cache-only `useQueries` — it never triggers a Jenkins fetch itself. The
 * global poller (`jenkins::start_poller`) keeps that cache fresh and
 * `useJenkinsStatusEvents()` (registered in `MainWindow`) writes the payloads in.
 */

import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { isTauri, useProjects, projectsQueryKeys } from '@/services/projects'
import { jenkinsQueryKeys } from '@/services/jenkins'
import { isFolder, type Project, type Worktree } from '@/types/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

export interface MissionControlRow {
  project: Project
  worktree: Worktree
  /** GitHub PR number as a string (never null — rows are PR-linked by filter). */
  prId: string
  /** Poller-fed status, or undefined until the cache is populated. */
  status: JenkinsWorktreeStatus | undefined
}

export interface MissionControlData {
  rows: MissionControlRow[]
  /** Non-folder projects with a Jenkins config (URL/user/token/preview). */
  jenkinsProjectCount: number
  /** Rows currently in FAILURE — surfaced in the header. */
  failureCount: number
  /** True while the per-project worktree lists are still loading. */
  isLoading: boolean
}

/** A non-folder project counts as Jenkins-enabled if any config field is set. */
export function isJenkinsConfigured(project: Project): boolean {
  return (
    !!project.jenkins_url ||
    !!project.jenkins_user ||
    !!project.jenkins_token ||
    !!project.jenkins_preview_url_template
  )
}

/**
 * Flatten per-project worktree lists into the PR-linked, non-archived worktrees
 * that the poller actually tracks, each paired with its project.
 */
export function selectPrWorktrees(
  jenkinsProjects: Project[],
  worktreeLists: (Worktree[] | undefined)[]
): { project: Project; worktree: Worktree; prId: string }[] {
  const out: { project: Project; worktree: Worktree; prId: string }[] = []
  jenkinsProjects.forEach((project, i) => {
    const worktrees = worktreeLists[i] ?? []
    for (const worktree of worktrees) {
      if (worktree.pr_number == null) continue
      if (worktree.archived_at != null) continue
      out.push({ project, worktree, prId: String(worktree.pr_number) })
    }
  })
  return out
}

/** Lower = more urgent (sorted to the top). */
const STATUS_PRIORITY: Record<string, number> = {
  FAILURE: 0,
  BUILDING: 1,
  QUEUED: 2,
  UNKNOWN: 3,
  SUCCESS: 4,
}

function priorityOf(status: JenkinsWorktreeStatus | undefined): number {
  return STATUS_PRIORITY[status?.overallStatus ?? 'UNKNOWN'] ?? 3
}

/** Most recent pipeline timestamp (newest first within a priority bucket). */
function recencyOf(status: JenkinsWorktreeStatus | undefined): number {
  return status?.pipeline?.timestampMs ?? 0
}

/** Sort comparator: urgency (failures first), then recency, then name. */
export function compareMissionControlRows(
  a: MissionControlRow,
  b: MissionControlRow
): number {
  const byPriority = priorityOf(a.status) - priorityOf(b.status)
  if (byPriority !== 0) return byPriority
  const byRecency = recencyOf(b.status) - recencyOf(a.status)
  if (byRecency !== 0) return byRecency
  return a.worktree.name.localeCompare(b.worktree.name)
}

export function useMissionControlRows(): MissionControlData {
  const { data: projects = [] } = useProjects()

  const jenkinsProjects = useMemo(
    () => projects.filter(p => !isFolder(p) && isJenkinsConfigured(p)),
    [projects]
  )

  // One worktree query per Jenkins project (mirrors `useWorktrees`).
  const worktreeQueries = useQueries({
    queries: jenkinsProjects.map(project => ({
      queryKey: projectsQueryKeys.worktrees(project.id),
      queryFn: async (): Promise<Worktree[]> => {
        if (!isTauri()) return []
        try {
          return await invoke<Worktree[]>('list_worktrees', {
            projectId: project.id,
          })
        } catch (error) {
          logger.error('Mission Control: failed to load worktrees', {
            error,
            projectId: project.id,
          })
          return []
        }
      },
      enabled: jenkinsProjects.length > 0,
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 10,
    })),
  })

  const isLoading = worktreeQueries.some(q => q.isLoading)

  // Flatten to PR-linked, non-archived worktrees, paired with their project.
  const prWorktrees = useMemo(
    () =>
      selectPrWorktrees(
        jenkinsProjects,
        worktreeQueries.map(q => q.data)
      ),
    // worktreeQueries identity changes each render; key off the data slices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jenkinsProjects, worktreeQueries.map(q => q.data)]
  )

  // Cache-only read of each worktree's Jenkins status (poller-fed; never fetches).
  const statusQueries = useQueries({
    queries: prWorktrees.map(({ worktree }) => ({
      queryKey: jenkinsQueryKeys.status(worktree.id),
      queryFn: () => {
        throw new Error('Mission Control statuses are cache-only')
      },
      enabled: false,
      staleTime: Infinity,
      gcTime: 1000 * 60 * 5,
    })),
  })

  const rows = useMemo(() => {
    const joined: MissionControlRow[] = prWorktrees.map((entry, i) => ({
      ...entry,
      status: statusQueries[i]?.data as JenkinsWorktreeStatus | undefined,
    }))
    return joined.sort(compareMissionControlRows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prWorktrees, statusQueries.map(q => q.data)])

  const failureCount = rows.filter(
    r => r.status?.overallStatus === 'FAILURE'
  ).length

  return {
    rows,
    jenkinsProjectCount: jenkinsProjects.length,
    failureCount,
    isLoading,
  }
}
