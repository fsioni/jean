import type { AiPipelineTask } from '@/types/ai-pipeline'

/**
 * Compact age label ("3 j", "5 h", "12 min") for a ClickUp epoch-ms timestamp
 * or an ISO-8601 date. Returns `null` when there is nothing to show — the list
 * shows "how long has this been sitting there", so precision beyond the unit
 * would be noise.
 */
export function formatAge(
  value: string | undefined,
  now = Date.now()
): string | null {
  if (!value) return null
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(ms) || ms <= 0) return null

  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  return `${days} j`
}

/**
 * Free-text filter over a pickable ticket: title, ClickUp id, PR number/branch
 * and tags. Case/accent-insensitive so typing "reglement" finds "règlement".
 */
export function taskMatchesQuery(task: AiPipelineTask, query: string): boolean {
  const q = normalize(query)
  if (!q) return true
  const haystack = [
    task.name,
    task.taskId,
    task.status ?? '',
    task.pr ? `#${task.pr.number} ${task.pr.branch} ${task.pr.title}` : '',
    ...task.tags,
  ]
    .map(normalize)
    .join(' ')
  return haystack.includes(q)
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}
