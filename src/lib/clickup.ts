/**
 * ClickUp helpers.
 *
 * Planexpo branches encode their ClickUp task as a `CU-<id>` prefix
 * (e.g. `CU-86caa8btx-fix-contrat` or `CU-86c997enp__desc`). This mirrors the
 * Rust `parse_clickup_task_id_from_branch` so the frontend can derive the task
 * link without a backend round-trip (no manual-override support — branch only).
 */

/** Build a ClickUp task URL from a task id. */
export function clickupTaskUrl(taskId: string): string {
  return `https://app.clickup.com/t/${taskId}`
}

/**
 * Extract the ClickUp task id from a `CU-<id>…` branch name, or null when the
 * branch doesn't follow the convention. Case-insensitive on the `CU-` prefix.
 */
export function clickUpTaskIdFromBranch(
  branch: string | null | undefined
): string | null {
  if (!branch) return null
  const match = branch.match(/^cu-([a-z0-9]+)/i)
  const id = match?.[1]
  return id ? id : null
}
