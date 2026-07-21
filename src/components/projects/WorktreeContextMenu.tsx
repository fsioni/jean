import {
  Archive,
  Code,
  FolderOpen,
  GitPullRequest,
  Globe,
  Hammer,
  Play,
  Rocket,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { getEditorLabel, getTerminalLabel } from '@/types/preferences'
import { isLocalBackend } from '@/lib/environment'
import { getFileManagerName } from '@/lib/platform'
import type { useWorktreeMenuActions } from './useWorktreeMenuActions'

interface WorktreeContextMenuProps {
  // Computed once by the parent (WorktreeItem) and passed in so the hook isn't
  // run twice per worktree row.
  actions: ReturnType<typeof useWorktreeMenuActions>
  children: React.ReactNode
}

export function WorktreeContextMenu({
  actions,
  children,
}: WorktreeContextMenuProps) {
  const {
    showDeleteConfirm,
    setShowDeleteConfirm,
    showFinishConfirm,
    setShowFinishConfirm,
    isBase,
    runScripts,
    preferences,
    handleRun,
    handleRunCommand,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleArchiveOrClose,
    handleDelete,
    finish,
    openLinks,
  } = actions

  const hasOpenLinks =
    !!openLinks.prUrl ||
    !!openLinks.jenkinsUrl ||
    !!openLinks.previewUrl ||
    !!openLinks.clickUpUrl

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {finish.canFinish && (
          <>
            <ContextMenuItem
              onClick={() => setShowFinishConfirm(true)}
              disabled={finish.isPending}
            >
              <Rocket className="mr-2 h-4 w-4 text-purple-600" />
              Terminer (TO DEPLOY + merge)
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {hasOpenLinks && (
          <>
            {openLinks.prUrl && (
              <ContextMenuItem onClick={openLinks.openPr}>
                <GitPullRequest className="mr-2 h-4 w-4" />
                Ouvrir la PR
              </ContextMenuItem>
            )}
            {openLinks.clickUpUrl && (
              <ContextMenuItem onClick={openLinks.openClickUp}>
                <ClickUpIcon className="mr-2 h-4 w-4" />
                Ouvrir ClickUp
              </ContextMenuItem>
            )}
            {openLinks.jenkinsUrl && (
              <ContextMenuItem onClick={openLinks.openJenkins}>
                <Hammer className="mr-2 h-4 w-4" />
                Ouvrir Jenkins
              </ContextMenuItem>
            )}
            {openLinks.previewUrl && (
              <ContextMenuItem onClick={openLinks.openPreview}>
                <Globe className="mr-2 h-4 w-4" />
                Ouvrir la preview
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        {runScripts.length === 1 && (
          <ContextMenuItem onClick={handleRun}>
            <Play className="mr-2 h-4 w-4" />
            Run
          </ContextMenuItem>
        )}
        {runScripts.length > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Play className="mr-2 h-4 w-4" />
              Run
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {runScripts.map((cmd, i) => (
                <ContextMenuItem
                  key={i}
                  onSelect={() => handleRunCommand(cmd)}
                  className="font-mono text-xs"
                >
                  {cmd}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        {isLocalBackend() && <ContextMenuSeparator />}

        {isLocalBackend() && (
          <ContextMenuItem onClick={handleOpenInEditor}>
            <Code className="mr-2 h-4 w-4" />
            Open in {getEditorLabel(preferences?.editor)}
          </ContextMenuItem>
        )}

        {isLocalBackend() && (
          <ContextMenuItem onClick={handleOpenInFinder}>
            <FolderOpen className="mr-2 h-4 w-4" />
            Open in {getFileManagerName()}
          </ContextMenuItem>
        )}

        {isLocalBackend() && (
          <ContextMenuItem onClick={handleOpenInTerminal}>
            <Terminal className="mr-2 h-4 w-4" />
            Open in {getTerminalLabel(preferences?.terminal)}
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleArchiveOrClose}>
          {isBase ? (
            <>
              <X className="mr-2 h-4 w-4" />
              Close Session
            </>
          ) : (
            <>
              <Archive className="mr-2 h-4 w-4" />
              Archive Worktree
            </>
          )}
        </ContextMenuItem>

        {!isBase && (
          <ContextMenuItem onClick={() => setShowDeleteConfirm(true)}>
            <Trash2 className="mr-2 h-4 w-4 text-destructive" />
            Delete Worktree
          </ContextMenuItem>
        )}
      </ContextMenuContent>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              handleDelete()
              setShowDeleteConfirm(false)
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Worktree</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the worktree, its branch, and all
              associated sessions. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              autoFocus
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
              <kbd className="ml-1.5 text-xs opacity-70">↵</kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showFinishConfirm} onOpenChange={setShowFinishConfirm}>
        <AlertDialogContent
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              finish.handleFinish()
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Terminer la feature</AlertDialogTitle>
            <AlertDialogDescription>
              La tâche ClickUp{' '}
              {finish.clickUpTaskId ? (
                <>
                  (<code>{finish.clickUpTaskId}</code>){' '}
                </>
              ) : null}
              passe en <span className="font-medium">TO DEPLOY</span>, puis la
              PR du worktree est mergée. Le merge ne peut pas être annulé.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction autoFocus onClick={finish.handleFinish}>
              Terminer
              <kbd className="ml-1.5 text-xs opacity-70">↵</kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ContextMenu>
  )
}
