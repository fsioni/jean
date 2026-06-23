import { describe, expect, it } from 'vitest'
import type { Project, Worktree } from '@/types/projects'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'
import {
  compareMissionControlRows,
  isJenkinsConfigured,
  selectPrWorktrees,
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
    status,
  }
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

describe('selectPrWorktrees', () => {
  it('keeps only PR-linked, non-archived worktrees and pairs them with the project', () => {
    const p = project({ id: 'p1', name: 'Proj' })
    const lists = [
      [
        worktree({ id: 'a', pr_number: 42 }),
        worktree({ id: 'b' }), // no PR → excluded
        worktree({ id: 'c', pr_number: 7, archived_at: 123 }), // archived → excluded
      ],
    ]
    const result = selectPrWorktrees([p], lists)
    expect(result.map(r => r.worktree.id)).toEqual(['a'])
    const [first] = result
    expect(first?.prId).toBe('42')
    expect(first?.project).toBe(p)
  })

  it('tolerates a project whose worktree list has not loaded yet', () => {
    expect(selectPrWorktrees([project({})], [undefined])).toEqual([])
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
