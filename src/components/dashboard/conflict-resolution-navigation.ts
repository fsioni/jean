import type { Worktree } from '@/types/projects'

type ConflictWorktree = Pick<Worktree, 'id' | 'path'>

interface CanvasConflictResolutionActions {
  setPendingMagicCommand: (cmd: { command: 'resolve-conflicts' }) => void
  openWorktreeModal: (worktreeId: string, worktreePath: string) => void
}

export function openCanvasConflictResolution(
  worktree: ConflictWorktree,
  actions: CanvasConflictResolutionActions
): void {
  actions.setPendingMagicCommand({ command: 'resolve-conflicts' })
  actions.openWorktreeModal(worktree.id, worktree.path)
}
