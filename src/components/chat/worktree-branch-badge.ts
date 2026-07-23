export function getStackedBaseBranch(
  baseBranch: string | undefined,
  worktreeBranch: string | undefined,
  defaultBranch: string | undefined,
  baseRemote?: string
): string | null {
  if (!baseBranch) return null

  // A base picked from an explicit remote is always worth showing: on a project
  // with several remotes, "main" alone doesn't say which repository it came from.
  if (baseRemote) return `${baseRemote}/${baseBranch}`

  if (baseBranch === defaultBranch || baseBranch === worktreeBranch) {
    return null
  }

  return baseBranch
}

interface WorktreeBranchBadgeContext {
  displayBranch: string | undefined
  worktreeName: string
  stackedBaseBranch: string | null
  prNumber?: number
  securityAlertNumber?: number
  advisoryGhsaId?: string
}

export function shouldShowWorktreeBranchBadge({
  displayBranch,
  worktreeName,
  stackedBaseBranch,
  prNumber,
  securityAlertNumber,
  advisoryGhsaId,
}: WorktreeBranchBadgeContext): boolean {
  return Boolean(
    displayBranch &&
    (displayBranch !== worktreeName ||
      stackedBaseBranch ||
      prNumber ||
      securityAlertNumber ||
      advisoryGhsaId)
  )
}
