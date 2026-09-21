import { useCallback } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import {
  useAiPipelineProjectId,
  useHasAiPipelineAccess,
} from '@/services/ai-pipeline'
import { AiPipelineTaskList } from '@/components/ai-pipeline/AiPipelineTaskList'
import { AiPipelineProjectPicker } from '@/components/ai-pipeline/AiPipelineProjectPicker'

/**
 * "Pipeline IA" tab of the New Session modal — the same pickable tickets as the
 * dedicated modal, scoped to the pinned project (not the project the modal was
 * opened from). Resuming keeps the modal open so several tickets can be picked
 * up in a row.
 */
export function AiPipelineTab({ isActive }: { isActive: boolean }) {
  const hasAccess = useHasAiPipelineAccess()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { projectId, isPinned, project } =
    useAiPipelineProjectId(selectedProjectId)

  // Focus the freshly created worktree; the modal stays open for the next one.
  const handleResumed = useCallback(
    (worktreeId: string, worktreePath: string) => {
      useChatStore.getState().setActiveWorktree(worktreeId, worktreePath)
      const { selectWorktree, expandProject } = useProjectsStore.getState()
      selectWorktree(worktreeId)
      if (projectId) expandProject(projectId)
    },
    [projectId]
  )

  if (!hasAccess) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        ClickUp n&apos;est pas configuré — renseigne ton token dans Réglages →
        Intégrations → ClickUp.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <AiPipelineTaskList
        projectId={projectId}
        enabled={isActive}
        onResumed={res => handleResumed(res.worktree.id, res.worktree.path)}
        header={
          <div className="flex items-center justify-between gap-2">
            <AiPipelineProjectPicker
              projectId={isPinned ? projectId : null}
              isPinned={isPinned}
            />
            {!isPinned && project && (
              <span className="truncate text-[11px] text-muted-foreground">
                Tickets de {project.name}
              </span>
            )}
          </div>
        }
      />
    </div>
  )
}

export default AiPipelineTab
