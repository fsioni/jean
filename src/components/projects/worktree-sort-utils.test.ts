import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import type { Worktree } from '@/types/projects'
import {
  compareWorktreesForCanvasSort,
  getSessionActivityTimestamp,
  getWorktreeLastActivity,
} from './worktree-sort-utils'

function worktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  const { id, ...rest } = overrides
  return {
    id,
    project_id: 'project-1',
    name: rest.name ?? id,
    path: `/tmp/${id}`,
    branch: rest.branch ?? rest.name ?? id,
    created_at: overrides.created_at ?? 1,
    order: overrides.order ?? 0,
    ...rest,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    name: overrides.name ?? 'Session 1',
    order: overrides.order ?? 0,
    created_at: overrides.created_at ?? 1,
    updated_at: overrides.updated_at ?? overrides.created_at ?? 1,
    messages: overrides.messages ?? [],
    ...overrides,
  } as Session
}

describe('worktree-sort-utils', () => {
  it('prefers last_message_at over updated_at and created_at', () => {
    expect(
      getSessionActivityTimestamp(
        session({ created_at: 10, updated_at: 20, last_message_at: 30 })
      )
    ).toBe(30)
    expect(getSessionActivityTimestamp(session({ created_at: 10 }))).toBe(10)
  })

  it('finds latest activity across sessions with worktree fallback', () => {
    expect(
      getWorktreeLastActivity(
        [
          session({ id: 'old', created_at: 10, updated_at: 20 }),
          session({ id: 'new', created_at: 30, last_message_at: 40 }),
        ],
        5
      )
    ).toBe(40)

    expect(getWorktreeLastActivity([], 50)).toBe(50)
  })

  it('sorts base sessions first, then by last activity desc', () => {
    const base = worktree({
      id: 'base',
      name: 'main',
      branch: 'main',
      session_type: 'base',
      created_at: 1,
    })
    const recent = worktree({ id: 'recent', created_at: 10 })
    const old = worktree({ id: 'old', created_at: 20 })
    const latestById = new Map([
      ['base', 1],
      ['recent', 100],
      ['old', 50],
    ])

    const sorted = [old, recent, base].sort((a, b) =>
      compareWorktreesForCanvasSort(a, b, latestById, 'last_activity')
    )

    expect(sorted.map(w => w.id)).toEqual(['base', 'recent', 'old'])
  })

  it('sorts created mode by created_at desc after base sessions', () => {
    const newest = worktree({ id: 'newest', created_at: 30, order: 100 })
    const oldest = worktree({ id: 'oldest', created_at: 10, order: 0 })
    const middle = worktree({ id: 'middle', created_at: 20, order: 50 })

    const sorted = [oldest, newest, middle].sort((a, b) =>
      compareWorktreesForCanvasSort(a, b, new Map(), 'created')
    )

    expect(sorted.map(w => w.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('uses created_at as tie-breaker', () => {
    const older = worktree({ id: 'older', created_at: 10 })
    const newer = worktree({ id: 'newer', created_at: 20 })
    const latestById = new Map([
      ['older', 100],
      ['newer', 100],
    ])

    const sorted = [older, newer].sort((a, b) =>
      compareWorktreesForCanvasSort(a, b, latestById, 'last_activity')
    )

    expect(sorted.map(w => w.id)).toEqual(['newer', 'older'])
  })
})
