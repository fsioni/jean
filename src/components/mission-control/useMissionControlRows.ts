/**
 * Cross-project aggregation for the Jenkins "Mission Control" view.
 *
 * Covers every PR the user has in flight, in four shapes:
 * - **linked**   — worktree whose PR is recorded in Jean (the nominal case).
 * - **detached** — worktree with no `pr_number`, but an open PR exists on its
 *                  branch. Jean's link is stale; we show it anyway and repair
 *                  the link in the background (`detect_and_link_pr`).
 * - **no-pr**    — worktree with no PR at all (branch still in progress).
 * - **orphan**   — the user's own open PR with no active worktree.
 *
 * Statuses come from two places:
 * - linked rows read the SAME poller-fed cache the worktree rows use
 *   (`jenkinsQueryKeys`), cache-only — the global poller keeps it fresh.
 * - detached/orphan rows are invisible to the poller (it only walks PR-linked
 *   worktrees), so they use the batch command, which fetches each Jenkins job's
 *   build list once for the whole set.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { isTauri, useProjects, projectsQueryKeys } from '@/services/projects'
import { useGitHubPRs, useSearchGitHubPRs } from '@/services/github'
import { jenkinsQueryKeys } from '@/services/jenkins'
import { isFolder, type Project, type Worktree } from '@/types/projects'
import type { GitHubPullRequest } from '@/types/github'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

/** Why a row is in the list — drives its badge and its sort bucket. */
export type MissionControlRowKind = 'linked' | 'detached' | 'no-pr'

export interface MissionControlRow {
  project: Project
  worktree: Worktree
  /** PR number as a string; empty when the worktree has no PR at all. */
  prId: string
  kind: MissionControlRowKind
  /** The open PR found on this branch while Jean's link was missing. */
  detectedPr?: GitHubPullRequest
  /** Poller-fed (linked) or batch-fed (detached) status; undefined until known. */
  status: JenkinsWorktreeStatus | undefined
}

/** One of the user's open PRs that has no active worktree. */
export interface MissionControlPrRow {
  project: Project
  pr: GitHubPullRequest
  status: JenkinsWorktreeStatus | undefined
}

export interface MissionControlData {
  rows: MissionControlRow[]
  /** The user's open PRs with no worktree — shown in their own section. */
  prRows: MissionControlPrRow[]
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

/** GitHub search that returns the signed-in user's open PRs. */
export const MY_OPEN_PRS_QUERY = 'is:open author:@me'

/**
 * Classify a project's non-archived worktrees, and pick out the user's open PRs
 * that no worktree covers.
 *
 * Pure so the (fiddly) matching rules are testable without React.
 */
export function classifyProjectRows(
  project: Project,
  worktrees: Worktree[],
  openPrs: GitHubPullRequest[],
  myOpenPrs: GitHubPullRequest[]
): { rows: Omit<MissionControlRow, 'status'>[]; orphans: GitHubPullRequest[] } {
  const active = worktrees.filter(w => w.archived_at == null)
  const prByBranch = new Map(openPrs.map(pr => [pr.headRefName, pr]))
  const rows: Omit<MissionControlRow, 'status'>[] = []

  for (const worktree of active) {
    if (worktree.pr_number != null) {
      rows.push({
        project,
        worktree,
        prId: String(worktree.pr_number),
        kind: 'linked',
      })
      continue
    }
    // No PR recorded in Jean: is there one on this branch anyway?
    const detected = prByBranch.get(worktree.branch)
    rows.push(
      detected
        ? {
            project,
            worktree,
            prId: String(detected.number),
            kind: 'detached',
            detectedPr: detected,
          }
        : { project, worktree, prId: '', kind: 'no-pr' }
    )
  }

  // A PR is covered when some active worktree carries its number or its branch.
  const coveredNumbers = new Set(rows.map(r => r.prId).filter(Boolean))
  const coveredBranches = new Set(active.map(w => w.branch))
  const orphans = myOpenPrs.filter(
    pr =>
      !coveredNumbers.has(String(pr.number)) &&
      !coveredBranches.has(pr.headRefName)
  )

  return { rows, orphans }
}

/** Lower = more urgent (sorted to the top). */
const STATUS_PRIORITY: Record<string, number> = {
  FAILURE: 0,
  BUILDING: 1,
  QUEUED: 2,
  UNKNOWN: 3,
  SUCCESS: 4,
}
/** Worktrees with no PR sort below everything: nothing is running for them. */
const NO_PR_PRIORITY = 5

function priorityOf(row: {
  kind?: MissionControlRowKind
  status: JenkinsWorktreeStatus | undefined
}): number {
  if (row.kind === 'no-pr') return NO_PR_PRIORITY
  return STATUS_PRIORITY[row.status?.overallStatus ?? 'UNKNOWN'] ?? 3
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
  const byPriority = priorityOf(a) - priorityOf(b)
  if (byPriority !== 0) return byPriority
  const byRecency = recencyOf(b.status) - recencyOf(a.status)
  if (byRecency !== 0) return byRecency
  return a.worktree.name.localeCompare(b.worktree.name)
}

/** Batch-status targets: the rows the poller doesn't cover. */
interface BatchTarget {
  key: string
  prId: string
  branch: string
}

export function useMissionControlRows(): MissionControlData {
  const { data: projects = [] } = useProjects()
  const queryClient = useQueryClient()

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

  // v1 covers a single Jenkins project's PRs (the `gh` queries are per repo).
  const primaryProject = jenkinsProjects[0]
  const projectPath = primaryProject?.path ?? null
  const { data: openPrs = [] } = useGitHubPRs(projectPath, 'open', {
    staleTime: 1000 * 60 * 2,
  })
  const { data: myOpenPrs = [] } = useSearchGitHubPRs(
    projectPath,
    MY_OPEN_PRS_QUERY
  )

  const { rows: bareRows, orphans } = useMemo(() => {
    const rows: Omit<MissionControlRow, 'status'>[] = []
    const orphans: { project: Project; pr: GitHubPullRequest }[] = []
    jenkinsProjects.forEach((project, i) => {
      const isPrimary = project.id === primaryProject?.id
      const classified = classifyProjectRows(
        project,
        worktreeQueries[i]?.data ?? [],
        isPrimary ? openPrs : [],
        isPrimary ? myOpenPrs : []
      )
      rows.push(...classified.rows)
      orphans.push(...classified.orphans.map(pr => ({ project, pr })))
    })
    return { rows, orphans }
    // worktreeQueries identity changes each render; key off the data slices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    jenkinsProjects,
    worktreeQueries.map(q => q.data),
    openPrs,
    myOpenPrs,
    primaryProject?.id,
  ])

  // Repair Jean's stale PR link in the background, once per worktree: the
  // poller only tracks worktrees with a `pr_number`, so until this lands the
  // row has no live status.
  const repaired = useRef(new Set<string>())
  useEffect(() => {
    if (!isTauri()) return
    for (const row of bareRows) {
      if (row.kind !== 'detached') continue
      if (repaired.current.has(row.worktree.id)) continue
      repaired.current.add(row.worktree.id)
      invoke('detect_and_link_pr', {
        worktreeId: row.worktree.id,
        worktreePath: row.worktree.path,
      })
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: projectsQueryKeys.worktrees(row.project.id),
          })
        )
        .catch(error =>
          logger.debug('Mission Control: PR re-link failed', {
            error,
            worktreeId: row.worktree.id,
          })
        )
    }
  }, [bareRows, queryClient])

  // Cache-only read of each linked worktree's status (poller-fed; never fetches).
  const statusQueries = useQueries({
    queries: bareRows.map(row => ({
      queryKey: jenkinsQueryKeys.status(row.worktree.id),
      queryFn: () => {
        throw new Error('Mission Control statuses are cache-only')
      },
      enabled: false,
      staleTime: Infinity,
      gcTime: 1000 * 60 * 5,
    })),
  })

  // Rows the poller ignores (detached worktrees + orphan PRs) get one batched
  // fetch instead of one full fetch each.
  const batchTargets = useMemo<BatchTarget[]>(() => {
    const targets: BatchTarget[] = bareRows
      .filter(row => row.kind === 'detached')
      .map(row => ({
        key: row.worktree.id,
        prId: row.prId,
        branch: row.worktree.branch,
      }))
    targets.push(
      ...orphans.map(({ pr }) => ({
        key: `pr-${pr.number}`,
        prId: String(pr.number),
        branch: pr.headRefName,
      }))
    )
    return targets
  }, [bareRows, orphans])

  const { data: batchStatuses = [] } = useQuery({
    queryKey: [
      ...jenkinsQueryKeys.all,
      'batch',
      primaryProject?.id ?? '',
      batchTargets.map(t => t.key).join(','),
    ],
    queryFn: async (): Promise<JenkinsWorktreeStatus[]> => {
      if (!primaryProject) return []
      try {
        return await invoke<JenkinsWorktreeStatus[]>('get_jenkins_statuses', {
          projectId: primaryProject.id,
          targets: batchTargets,
        })
      } catch (error) {
        logger.debug('Mission Control: batch status failed', { error })
        return []
      }
    },
    enabled: isTauri() && !!primaryProject && batchTargets.length > 0,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    retry: 0,
  })

  const batchByKey = useMemo(
    () => new Map(batchStatuses.map(s => [s.worktreeId, s])),
    [batchStatuses]
  )

  const rows = useMemo(() => {
    const joined: MissionControlRow[] = bareRows.map((row, i) => ({
      ...row,
      status:
        (statusQueries[i]?.data as JenkinsWorktreeStatus | undefined) ??
        batchByKey.get(row.worktree.id),
    }))
    return joined.sort(compareMissionControlRows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bareRows, statusQueries.map(q => q.data), batchByKey])

  const prRows = useMemo<MissionControlPrRow[]>(
    () =>
      orphans.map(({ project, pr }) => ({
        project,
        pr,
        status: batchByKey.get(`pr-${pr.number}`),
      })),
    [orphans, batchByKey]
  )

  const failureCount =
    rows.filter(r => r.status?.overallStatus === 'FAILURE').length +
    prRows.filter(r => r.status?.overallStatus === 'FAILURE').length

  return {
    rows,
    prRows,
    jenkinsProjectCount: jenkinsProjects.length,
    failureCount,
    isLoading,
  }
}
