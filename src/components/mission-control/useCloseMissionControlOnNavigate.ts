/**
 * Mission Control is a full-page view rendered INSTEAD of the chat / project
 * canvas (see `MainWindowContent`). Nothing outside the view itself used to
 * reset `missionControlOpen`, so picking a project or a worktree in the sidebar
 * changed the selection while the main pane stayed stuck on Mission Control —
 * the user had to hit the back arrow first.
 *
 * This hook makes any navigation dismiss the view: it watches the navigation
 * target (selected project / selected worktree / active worktree path) and
 * closes Mission Control as soon as it changes.
 *
 * Lives here (not in the shared stores) so the fork keeps a single point of
 * contact in upstream files — see `docs/developer/fork-workflow.md`.
 */

import { useEffect, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

export function useCloseMissionControlOnNavigate(): void {
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)

  const target = `${selectedProjectId}|${selectedWorktreeId}|${activeWorktreePath}`
  // Seeded with the mount-time target so restoring a selection never counts as
  // a navigation. Only later changes close the view.
  const previousTarget = useRef(target)

  useEffect(() => {
    if (previousTarget.current === target) return
    previousTarget.current = target
    // No-op guarded in the store when already closed.
    useUIStore.getState().setMissionControlOpen(false)
  }, [target])
}
