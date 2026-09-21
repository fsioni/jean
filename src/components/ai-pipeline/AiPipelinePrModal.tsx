import { useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2, GitPullRequest, Rocket } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useResolvedClickUpTaskId } from '@/services/clickup'
import {
  useAiPipelineProjectId,
  useFinishAiPipelinePr,
  useHasAiPipelineAccess,
} from '@/services/ai-pipeline'
import { reportSteps } from '@/lib/ai-pipeline-steps'
import { AiPipelineTaskList } from './AiPipelineTaskList'
import { AiPipelineProjectPicker } from './AiPipelineProjectPicker'

/**
 * Dedicated modal for the AI pipeline lifecycle: pick up tickets (review or
 * STUCK) and finish the current one (ClickUp → TO DEPLOY + merge).
 *
 * The list is scoped to the **pinned** project, so the same tickets show up
 * whatever the entry point. Resuming keeps the modal open — picking up five
 * tickets in a row is one click each.
 */
export function AiPipelinePrModal() {
  const open = useUIStore(state => state.aiPipelineModalOpen)
  const contextProjectId = useUIStore(state => state.aiPipelineModalProjectId)
  const setOpen = useUIStore(state => state.setAiPipelineModalOpen)

  const hasAccess = useHasAiPipelineAccess()
  const { projectId, isPinned, project } =
    useAiPipelineProjectId(contextProjectId)

  const finish = useFinishAiPipelinePr(projectId)

  // Active worktree context (for the "finish" action).
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const { data: activeTaskId } = useResolvedClickUpTaskId(activeWorktreeId)

  const handleFinish = useCallback(() => {
    if (!activeWorktreePath) return
    const toastId = toast.loading('Terminer : ClickUp → TO DEPLOY + merge…')
    finish.mutate(
      { worktreePath: activeWorktreePath, taskId: activeTaskId ?? undefined },
      {
        onSuccess: res =>
          reportSteps(toastId, 'PR terminée', [res.clickup, res.merge]),
        onError: e => toast.error(`Échec : ${e}`, { id: toastId }),
      }
    )
  }, [finish, activeWorktreePath, activeTaskId])

  // Select the freshly created worktree without closing the modal, so the next
  // ticket stays one click away.
  const handleResumed = useCallback(
    (worktreeId: string, worktreePath: string) => {
      useChatStore.getState().setActiveWorktree(worktreeId, worktreePath)
      const { selectWorktree, expandProject } = useProjectsStore.getState()
      selectWorktree(worktreeId)
      if (projectId) expandProject(projectId)
    },
    [projectId]
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[80vh] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <GitPullRequest className="size-4 text-muted-foreground" />
            <DialogTitle>Pipeline IA</DialogTitle>
            <div className="ml-auto flex items-center gap-1">
              <ModalCloseButton onClick={() => setOpen(false)} />
            </div>
          </div>
        </DialogHeader>

        {!hasAccess ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            ClickUp n&apos;est pas configuré.
            <br />
            Renseigne ton token dans{' '}
            <span className="font-medium">
              Réglages → Intégrations → ClickUp
            </span>
            .
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* Finish the current worktree's PR */}
            {activeWorktreeId && activeWorktreePath && (
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Rocket className="size-4 text-muted-foreground" />
                  Terminer la PR courante
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    ClickUp → <span className="font-medium">TO DEPLOY</span>{' '}
                    puis merge de la PR du worktree actif
                    {activeTaskId ? (
                      <>
                        {' '}
                        (tâche <code>{activeTaskId}</code>)
                      </>
                    ) : (
                      ' (aucune tâche ClickUp liée)'
                    )}
                    .
                  </div>
                  <Button
                    size="sm"
                    onClick={handleFinish}
                    disabled={finish.isPending}
                  >
                    {finish.isPending && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    Terminer
                  </Button>
                </div>
              </div>
            )}

            <AiPipelineTaskList
              projectId={projectId}
              enabled={open}
              onResumed={res =>
                handleResumed(res.worktree.id, res.worktree.path)
              }
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
        )}
      </DialogContent>
    </Dialog>
  )
}

export default AiPipelinePrModal
