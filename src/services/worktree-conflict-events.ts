import type { WorktreeOrigin } from '@/types/projects'

export function shouldSuppressAutoFixConflictNotification(event: {
  origin?: WorktreeOrigin | null
}): boolean {
  return event.origin === 'auto_fix'
}
