export function collectWorktreePaths(
  worktreesByProject?: Record<string, unknown[]>
): Record<string, string> {
  const paths: Record<string, string> = {}
  if (!worktreesByProject) return paths

  for (const worktrees of Object.values(worktreesByProject)) {
    for (const wt of worktrees) {
      if (
        typeof wt === 'object' &&
        wt !== null &&
        'id' in wt &&
        'path' in wt &&
        typeof wt.id === 'string' &&
        typeof wt.path === 'string' &&
        wt.id &&
        wt.path
      ) {
        paths[wt.id] = wt.path
      }
    }
  }

  return paths
}
