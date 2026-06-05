import type { LabelData } from '@/types/chat'
import type { Worktree } from '@/types/projects'

export interface PinnedWorktreeLabelTab {
  value: `label:${string}`
  label: string
  labelName: string
  color: string
  count: number
}

export function getWorktreeLabels(
  worktree: Pick<Worktree, 'labels' | 'label'> | null | undefined
): LabelData[] {
  if (!worktree) return []
  const labels =
    worktree.labels && worktree.labels.length > 0
      ? worktree.labels
      : worktree.label
        ? [worktree.label]
        : []
  const seen = new Set<string>()
  const result: LabelData[] = []
  for (const label of labels) {
    const key = label.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(label)
  }
  return result
}

export function updateWorktreeLabelsByName(
  labels: LabelData[],
  labelName: string,
  newColor: string
): LabelData[] {
  return labels.map(label =>
    label.name === labelName ? { ...label, color: newColor } : label
  )
}

export function getPinnedWorktreeLabelTabs(
  worktrees: Pick<Worktree, 'labels' | 'label' | 'status'>[]
): PinnedWorktreeLabelTab[] {
  const tabs = new Map<string, PinnedWorktreeLabelTab>()

  // First collect which label names should be shown as pinned filter tabs.
  for (const worktree of worktrees) {
    if (worktree.status === 'deleting') continue

    for (const label of getWorktreeLabels(worktree)) {
      if (!label.pinned) continue

      const key = label.name.toLowerCase()
      if (tabs.has(key)) continue

      tabs.set(key, {
        value: `label:${key}`,
        label: label.name,
        labelName: label.name,
        color: label.color,
        count: 0,
      })
    }
  }

  // Then count all worktrees with those label names. Only one label instance
  // needs to be pinned to create the tab; the tab filter matches by label name.
  for (const worktree of worktrees) {
    if (worktree.status === 'deleting') continue

    const seenOnWorktree = new Set<string>()
    for (const label of getWorktreeLabels(worktree)) {
      const key = label.name.toLowerCase()
      const tab = tabs.get(key)
      if (!tab || seenOnWorktree.has(key)) continue

      seenOnWorktree.add(key)
      tab.count += 1
    }
  }

  return [...tabs.values()]
}
