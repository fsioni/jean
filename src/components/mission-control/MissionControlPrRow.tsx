import { useCallback, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ExternalLink, GitBranch, Loader2, Plus } from 'lucide-react'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { clickUpTaskIdFromBranch, clickupTaskUrl } from '@/lib/clickup'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import { Button } from '@/components/ui/button'
import { projectsQueryKeys } from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { Worktree } from '@/types/projects'
import { JenkinsVerdict } from '@/components/jenkins/JenkinsVerdict'
import type { MissionControlPrRow as PrRow } from './useMissionControlRows'

/**
 * One of the user's open PRs that has no worktree in Jean — typically opened
 * from the CLI, or whose worktree was archived.
 *
 * Deliberately lighter than {@link MissionControlRow}: there is no checkout to
 * act on, so the row shows the CI verdict and offers the one action that makes
 * the PR actionable — checking it out (which restores an archived worktree when
 * there is one).
 */
export function MissionControlPrRow({ row }: { row: PrRow }) {
  const { project, pr, status } = row
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)

  const clickUpId = clickUpTaskIdFromBranch(pr.headRefName)

  const handleCheckout = useCallback(async () => {
    setCreating(true)
    const toastId = toast.loading(`Récupération de la PR #${pr.number}…`)
    try {
      const worktree = await invoke<Worktree>('checkout_pr', {
        projectId: project.id,
        prNumber: pr.number,
      })
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(project.id),
      })
      toast.success(`Worktree prêt pour la PR #${pr.number}`, { id: toastId })

      // Land on the new worktree (Mission Control closes on navigation).
      useUIStore.getState().setMissionControlOpen(false)
      useProjectsStore.getState().selectProject(project.id)
      useProjectsStore.getState().expandProject(project.id)
      useProjectsStore.getState().selectWorktree(worktree.id)
      useChatStore.getState().setActiveWorktree(worktree.id, worktree.path)
    } catch (error) {
      logger.error('Mission Control: checkout_pr failed', { error })
      toast.error(`Échec de la récupération : ${error}`, { id: toastId })
    } finally {
      setCreating(false)
    }
  }, [project.id, pr.number, queryClient])

  return (
    <div className="border-b border-border/60 transition-colors hover:bg-muted/40">
      <div className="flex items-center gap-2 px-3 py-2 pl-8">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="truncate font-medium text-foreground">
              {pr.title}
            </span>
            {pr.isDraft && (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
                brouillon
              </span>
            )}
            <span className="shrink-0 text-muted-foreground">·</span>
            <span className="truncate text-xs text-muted-foreground">
              {project.name}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono">{pr.headRefName}</span>
            <button
              type="button"
              onClick={() => openUrl(pr.url ?? '')}
              disabled={!pr.url}
              className="inline-flex shrink-0 items-center gap-0.5 transition-colors hover:text-foreground disabled:opacity-50"
              title="Ouvrir la PR sur GitHub"
            >
              #{pr.number}
              <ExternalLink className="size-3" />
            </button>
            {clickUpId && (
              <button
                type="button"
                onClick={() => openUrl(clickupTaskUrl(clickUpId))}
                className="inline-flex shrink-0 items-center gap-0.5 transition-colors hover:text-foreground"
                title="Ouvrir le ticket ClickUp"
              >
                <ClickUpIcon className="size-3" />
                ClickUp
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <JenkinsVerdict status={status} />
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheckout}
            disabled={creating}
            title="Créer (ou restaurer) le worktree de cette PR dans Jean"
          >
            {creating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Récupérer
          </Button>
        </div>
      </div>
    </div>
  )
}

export default MissionControlPrRow
