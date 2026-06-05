import { describe, expect, it } from 'vitest'
import type { LabelData } from '@/types/chat'
import type { Worktree } from '@/types/projects'
import {
  getPinnedWorktreeLabelTabs,
  getWorktreeLabels,
  updateWorktreeLabelsByName,
} from './worktree-labels'

function worktree(
  id: string,
  labels: LabelData[],
  overrides: Partial<Worktree> = {}
): Worktree {
  return {
    id,
    project_id: 'project-1',
    name: id,
    path: `/tmp/${id}`,
    branch: 'main',
    created_at: 1,
    status: 'ready',
    order: 0,
    labels,
    ...overrides,
  }
}

describe('getWorktreeLabels', () => {
  it('preserves pinned metadata when normalizing labels', () => {
    expect(
      getWorktreeLabels(
        worktree('one', [
          { name: 'Needs testing', color: '#eab308', pinned: true },
        ])
      )
    ).toEqual([{ name: 'Needs testing', color: '#eab308', pinned: true }])
  })
})

describe('updateWorktreeLabelsByName', () => {
  it('preserves pinned metadata when changing a label color', () => {
    expect(
      updateWorktreeLabelsByName(
        [{ name: 'QA', color: '#eab308', pinned: true }],
        'QA',
        '#22c55e'
      )
    ).toEqual([{ name: 'QA', color: '#22c55e', pinned: true }])
  })
})

describe('getPinnedWorktreeLabelTabs', () => {
  it('counts every worktree with a pinned label name, even when only one instance is pinned', () => {
    const tabs = getPinnedWorktreeLabelTabs([
      worktree('one', [{ name: 'v4.2', color: '#84cc16', pinned: true }]),
      worktree('two', [{ name: 'v4.2', color: '#84cc16' }]),
      worktree('three', [{ name: 'v4.2', color: '#84cc16' }]),
      worktree('four', [{ name: 'v4.2', color: '#84cc16' }]),
      worktree('deleting', [{ name: 'v4.2', color: '#84cc16' }], {
        status: 'deleting',
      }),
      worktree('blocked', [
        { name: 'Blocked', color: '#ef4444', pinned: true },
      ]),
    ])

    expect(tabs).toEqual([
      {
        value: 'label:v4.2',
        label: 'v4.2',
        color: '#84cc16',
        count: 4,
        labelName: 'v4.2',
      },
      {
        value: 'label:blocked',
        label: 'Blocked',
        color: '#ef4444',
        count: 1,
        labelName: 'Blocked',
      },
    ])
  })

  it('returns current-project pinned labels with counts', () => {
    const tabs = getPinnedWorktreeLabelTabs([
      worktree('one', [{ name: 'QA', color: '#eab308', pinned: true }]),
      worktree('two', [
        { name: 'QA', color: '#22c55e', pinned: true },
        { name: 'Later', color: '#3b82f6' },
      ]),
      worktree('three', [{ name: 'Blocked', color: '#ef4444', pinned: true }]),
      worktree('deleting', [{ name: 'QA', color: '#a855f7', pinned: true }], {
        status: 'deleting',
      }),
    ])

    expect(tabs).toEqual([
      {
        value: 'label:qa',
        label: 'QA',
        color: '#eab308',
        count: 2,
        labelName: 'QA',
      },
      {
        value: 'label:blocked',
        label: 'Blocked',
        color: '#ef4444',
        count: 1,
        labelName: 'Blocked',
      },
    ])
  })
})
