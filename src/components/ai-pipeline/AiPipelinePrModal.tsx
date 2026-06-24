import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  RefreshCw,
  GitPullRequest,
  ExternalLink,
  ClipboardList,
  Gauge,
  Rocket,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { openExternal } from '@/lib/platform'
import { useResolvedClickUpTaskId } from '@/services/clickup'
import {
  useAiPipelineConfig,
  useAiPipelineReviewTasks,
  useHasAiPipelineAccess,
  useResumeAiPipelinePr,
  useFinishAiPipelinePr,
} from '@/services/ai-pipeline'
import type { AiPipelinePr } from '@/types/ai-pipeline'
import { clickupTaskUrl } from '@/lib/clickup'
import { reportSteps } from '@/lib/ai-pipeline-steps'

/** Small inline link chip (mirrors the row's "GitHub" affordance). */
function LinkChip({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof ExternalLink
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  )
}

function CiBadge({ ci }: { ci?: string }) {
  if (!ci) return null
  const map: Record<string, { cls: string; icon: React.ReactNode }> = {
    SUCCESS: {
      cls: 'bg-green-500/10 text-green-600 dark:text-green-400',
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    FAILURE: {
      cls: 'bg-red-500/10 text-red-600 dark:text-red-400',
      icon: <XCircle className="h-3 w-3" />,
    },
    PENDING: {
      cls: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
      icon: <Clock className="h-3 w-3" />,
    },
  }
  const entry = map[ci] ?? {
    cls: 'bg-muted text-muted-foreground',
    icon: null,
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${entry.cls}`}
    >
      {entry.icon}
      {ci}
    </span>
  )
}

function Pill({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode
  tone?: 'muted' | 'warn'
}) {
  const cls =
    tone === 'warn'
      ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400'
      : 'bg-muted text-muted-foreground'
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  )
}

/**
 * Dedicated modal to resume an AI-pipeline PR (create a worktree + self-assign
 * on both the ClickUp task and the GitHub PR) and to finish the current one
 * (ClickUp → TO DEPLOY + merge). Does NOT touch the worktree list rows.
 */
export function AiPipelinePrModal() {
  const open = useUIStore(state => state.aiPipelineModalOpen)
  const projectId = useUIStore(state => state.aiPipelineModalProjectId)
  const setOpen = useUIStore(state => state.setAiPipelineModalOpen)

  const hasAccess = useHasAiPipelineAccess()
  const {
    data: tasks,
    isLoading,
    isError,
    error,
    isFetching,
    refetch,
  } = useAiPipelineReviewTasks(projectId, { enabled: open })

  const { data: config } = useAiPipelineConfig()
  const dashboardUrl = config?.dashboardUrl?.trim().replace(/\/+$/, '') ?? ''

  const resume = useResumeAiPipelinePr(projectId)
  const finish = useFinishAiPipelinePr(projectId)

  // Active worktree context (for the "finish" action).
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const { data: activeTaskId } = useResolvedClickUpTaskId(activeWorktreeId)

  const handleResume = useCallback(
    (pr: AiPipelinePr) => {
      const toastId = toast.loading(`Reprise de la PR #${pr.number}…`)
      resume.mutate(
        { prNumber: pr.number },
        {
          onSuccess: res => {
            reportSteps(toastId, `PR #${pr.number} reprise`, [
              res.github,
              res.clickup,
            ])
            // Navigate into the freshly created worktree.
            useChatStore
              .getState()
              .setActiveWorktree(res.worktree.id, res.worktree.path)
            const { selectWorktree, expandProject } =
              useProjectsStore.getState()
            selectWorktree(res.worktree.id)
            if (projectId) expandProject(projectId)
            setOpen(false)
          },
          onError: e =>
            toast.error(`Échec de la reprise de la PR #${pr.number} : ${e}`, {
              id: toastId,
            }),
        }
      )
    },
    [resume, projectId, setOpen]
  )

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[80vh] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <GitPullRequest className="h-4 w-4 text-muted-foreground" />
            <DialogTitle>PR de la pipeline IA</DialogTitle>
            <div className="ml-auto flex items-center gap-1">
              {dashboardUrl && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 p-0"
                  onClick={() => openExternal(`${dashboardUrl}/dashboard`)}
                  title="Ouvrir le dashboard full flow"
                >
                  <Gauge className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 p-0"
                onClick={() => refetch()}
                disabled={isFetching || !hasAccess}
                title="Rafraîchir"
              >
                <RefreshCw
                  className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`}
                />
              </Button>
              <ModalCloseButton onClick={() => setOpen(false)} />
            </div>
          </div>
        </DialogHeader>

        {!hasAccess ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Aucun dashboard IA configuré.
            <br />
            Renseigne son URL dans{' '}
            <span className="font-medium">
              Réglages → Intégrations → Pipeline IA
            </span>
            .
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            {/* Finish the current worktree's PR */}
            {activeWorktreeId && activeWorktreePath && (
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Rocket className="h-4 w-4 text-muted-foreground" />
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
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    Terminer
                  </Button>
                </div>
              </div>
            )}

            {/* Resume a TO-REVIEW ticket (ClickUp = source of truth) */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Tickets à reprendre · TO REVIEW / IN REVIEW (libres ou à moi)
              </div>
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : isError ? (
                <div className="px-2 py-8 text-center text-sm text-destructive">
                  Erreur de chargement :{' '}
                  {error instanceof Error ? error.message : String(error)}
                </div>
              ) : !tasks || tasks.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Aucun ticket en review à reprendre pour ce projet (libre ou
                  assigné à toi).
                </div>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-2 pr-2">
                    {tasks.map(task => {
                      const pr = task.pr
                      return (
                        <div
                          key={task.taskId}
                          className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1 space-y-2">
                            {/* Ticket name */}
                            <div className="min-w-0 truncate text-sm font-medium">
                              {task.name}
                            </div>

                            {/* Ownership + status, then the PR state */}
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                              {task.assignedToMe ? (
                                <Pill>à moi</Pill>
                              ) : (
                                <Pill tone="warn">libre</Pill>
                              )}
                              {task.status && (
                                <Pill>{task.status.toUpperCase()}</Pill>
                              )}
                              <span
                                aria-hidden
                                className="h-3 w-px bg-border"
                              />
                              <span className="text-[10px] tabular-nums text-muted-foreground">
                                PR #{pr.number}
                              </span>
                              <CiBadge ci={pr.ci} />
                              {pr.isDraft && <Pill>draft</Pill>}
                              {pr.mergeable === 'CONFLICTING' && (
                                <Pill tone="warn">conflits</Pill>
                              )}
                            </div>

                            {/* Links */}
                            <div className="flex flex-wrap items-center gap-3">
                              <LinkChip
                                icon={ExternalLink}
                                label="GitHub"
                                onClick={() => openExternal(pr.url)}
                              />
                              <LinkChip
                                icon={ClipboardList}
                                label={`Ticket ${task.taskId}`}
                                onClick={() =>
                                  openExternal(
                                    task.url ?? clickupTaskUrl(task.taskId)
                                  )
                                }
                              />
                              {dashboardUrl && (
                                <LinkChip
                                  icon={Gauge}
                                  label="Flow"
                                  onClick={() =>
                                    openExternal(
                                      `${dashboardUrl}/ticket/${task.taskId}`
                                    )
                                  }
                                />
                              )}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            title="Crée un worktree depuis la PR et t'assigne sur la tâche ClickUp + la PR GitHub"
                            onClick={() => handleResume(pr)}
                            disabled={resume.isPending}
                          >
                            {resume.isPending && (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            Reprendre
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default AiPipelinePrModal
