import { describe, expect, it } from 'vitest'
import type { Project, Worktree } from '@/types/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'
import type { GitHubPullRequest } from '@/types/github'
import {
  classifyProjectRows,
  compareMissionControlRows,
  isJenkinsConfigured,
  type MissionControlRow,
} from './useMissionControlRows'

function project(partial: Partial<Project>): Project {
  return { id: 'p1', name: 'Proj', path: '/p', ...partial } as Project
}

function worktree(partial: Partial<Worktree>): Worktree {
  return {
    id: 'wt',
    project_id: 'p1',
    name: 'wt',
    path: '/p/wt',
    branch: 'feat',
    order: 0,
    created_at: 0,
    ...partial,
  } as Worktree
}

function row(
  name: string,
  overallStatus?: string,
  timestampMs = 0
): MissionControlRow {
  const status: JenkinsWorktreeStatus | undefined = overallStatus
    ? ({
        worktreeId: name,
        overallStatus,
        pipeline: { timestampMs } as JenkinsWorktreeStatus['pipeline'],
      } as JenkinsWorktreeStatus)
    : undefined
  return {
    project: project({}),
    worktree: worktree({ id: name, name }),
    prId: '1',
    kind: 'linked',
    status,
  }
}

function pr(partial: Partial<GitHubPullRequest>): GitHubPullRequest {
  return {
    number: 1,
    title: 'PR',
    state: 'OPEN',
    headRefName: 'feat',
    baseRefName: 'master',
    isDraft: false,
    created_at: '',
    author: { login: 'me' },
    labels: [],
    ...partial,
  } as GitHubPullRequest
}

describe('isJenkinsConfigured', () => {
  it('is true when any Jenkins field is set', () => {
    expect(isJenkinsConfigured(project({ jenkins_url: 'https://ci' }))).toBe(
      true
    )
    expect(isJenkinsConfigured(project({ jenkins_token: 't' }))).toBe(true)
  })
  it('is false when no Jenkins field is set', () => {
    expect(isJenkinsConfigured(project({}))).toBe(false)
  })
})

describe('classifyProjectRows', () => {
  const p = project({ id: 'p1', name: 'Proj' })

  it('classifies a PR-linked worktree, ignoring archived ones', () => {
    const { rows } = classifyProjectRows(
      p,
      [
        worktree({ id: 'a', pr_number: 42 }),
        worktree({ id: 'c', pr_number: 7, archived_at: 123 }),
      ],
      [],
      []
    )
    expect(rows.map(r => [r.worktree.id, r.kind, r.prId])).toEqual([
      ['a', 'linked', '42'],
    ])
  })

  it('recovers a worktree whose PR link is missing in Jean', () => {
    const { rows } = classifyProjectRows(
      p,
      [worktree({ id: 'a', branch: 'feat-x' })],
      [pr({ number: 99, headRefName: 'feat-x' })],
      []
    )
    expect(rows[0]?.kind).toBe('detached')
    expect(rows[0]?.prId).toBe('99')
    expect(rows[0]?.detectedPr?.number).toBe(99)
  })

  it('keeps a worktree that genuinely has no PR', () => {
    const { rows } = classifyProjectRows(
      p,
      [worktree({ id: 'a', branch: 'wip' })],
      [pr({ number: 99, headRefName: 'other' })],
      []
    )
    expect(rows[0]?.kind).toBe('no-pr')
    expect(rows[0]?.prId).toBe('')
  })

  it('surfaces the user own open PRs that no worktree covers', () => {
    const { orphans } = classifyProjectRows(
      p,
      [worktree({ id: 'a', pr_number: 42, branch: 'feat-42' })],
      [],
      [
        pr({ number: 42, headRefName: 'feat-42' }),
        pr({ number: 77, headRefName: 'feat-77' }),
      ]
    )
    expect(orphans.map(o => o.number)).toEqual([77])
  })

  it('does not call a PR orphan when a worktree sits on its branch', () => {
    // Branch match is enough: the worktree may simply have a stale PR link.
    const { orphans } = classifyProjectRows(
      p,
      [worktree({ id: 'a', branch: 'feat-77' })],
      [],
      [pr({ number: 77, headRefName: 'feat-77' })]
    )
    expect(orphans).toEqual([])
  })
})

describe('compareMissionControlRows (urgency sort)', () => {
  it('orders FAILURE < BUILDING < QUEUED < UNKNOWN < SUCCESS', () => {
    const rows = [
      row('ok', 'SUCCESS'),
      row('unknown'),
      row('queued', 'QUEUED'),
      row('building', 'BUILDING'),
      row('fail', 'FAILURE'),
    ]
    const sorted = [...rows].sort(compareMissionControlRows)
    expect(sorted.map(r => r.worktree.name)).toEqual([
      'fail',
      'building',
      'queued',
      'unknown',
      'ok',
    ])
  })

  it('breaks ties within a status by most-recent pipeline first', () => {
    const older = row('older', 'FAILURE', 1000)
    const newer = row('newer', 'FAILURE', 5000)
    const sorted = [older, newer].sort(compareMissionControlRows)
    expect(sorted.map(r => r.worktree.name)).toEqual(['newer', 'older'])
  })
})
