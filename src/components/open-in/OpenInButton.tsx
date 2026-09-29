import { useCallback } from 'react'
import {
  Code,
  Terminal,
  FolderOpen,
  Github,
  ChevronDown,
  Settings,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  useOpenWorktreeInEditor,
  useOpenWorktreeInTerminal,
  useOpenWorktreeInFinder,
  useOpenBranchOnGitHub,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { getOpenInDefaultLabel } from '@/types/preferences'
import {
  canOpenInEditor,
  canOpenInFinder,
  canOpenInTerminal,
} from '@/lib/environment'
import { useUIStore } from '@/store/ui-store'

interface OpenInButtonProps {
  worktreePath: string
  serverId?: string
  branch?: string | null
  className?: string
}

export function OpenInButton({
  worktreePath,
  serverId,
  branch,
  className,
}: OpenInButtonProps) {
  const { data: preferences } = usePreferences()
  const openPreferencesPane = useUIStore(state => state.openPreferencesPane)
  const openInEditor = useOpenWorktreeInEditor()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInFinder = useOpenWorktreeInFinder()
  const openOnGitHub = useOpenBranchOnGitHub()

  const canFinder = canOpenInFinder(serverId)
  const canEditor = canOpenInEditor()
  const canTerminal = canOpenInTerminal()

  const openAction = useCallback(
    (target: string) => {
      switch (target) {
        case 'terminal':
          openInTerminal.mutate({
            worktreePath,
            terminal: preferences?.terminal,
          })
          break
        case 'finder':
          openInFinder.mutate(worktreePath)
          break
        case 'github':
          if (branch) openOnGitHub.mutate({ repoPath: worktreePath, branch })
          else
            openInEditor.mutate({ worktreePath, editor: preferences?.editor })
          break
        default:
          openInEditor.mutate({ worktreePath, editor: preferences?.editor })
      }
    },
    [
      openInEditor,
      openInTerminal,
      openInFinder,
      openOnGitHub,
      worktreePath,
      branch,
      preferences?.editor,
      preferences?.terminal,
    ]
  )

  // Prefer the user's default when that target is available on this host.
  const preferred = preferences?.open_in ?? 'editor'
  const effectiveDefault =
    preferred === 'editor' && canEditor
      ? 'editor'
      : preferred === 'terminal' && canTerminal
        ? preferred
        : preferred === 'finder' && canFinder
          ? preferred
          : preferred === 'github' && branch
            ? 'github'
            : canEditor
              ? 'editor'
              : branch
                ? 'github'
                : 'editor'

  const defaultLabel = getOpenInDefaultLabel(
    effectiveDefault,
    preferences?.editor,
    preferences?.terminal
  )

  if (!canEditor && !canTerminal && !canFinder) return null

  return (
    <div
      className={`hidden h-7 items-center rounded-md border border-primary bg-primary sm:inline-flex dark:border-border/50 dark:bg-muted/50 ${className ?? ''}`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className="h-full rounded-r-none border-0 px-2.5 text-xs text-primary-foreground/85 hover:bg-primary-foreground/10 hover:text-primary-foreground dark:text-muted-foreground dark:hover:text-foreground"
            onClick={() => openAction(effectiveDefault)}
          >
            Open in {defaultLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in {defaultLabel}</TooltipContent>
      </Tooltip>
      <div className="h-4 w-px bg-primary-foreground/20 dark:bg-border/50" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-full w-6 rounded-l-none border-0 px-0 text-primary-foreground/85 hover:bg-primary-foreground/10 hover:text-primary-foreground dark:text-muted-foreground dark:hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canEditor && (
            <DropdownMenuItem onSelect={() => openAction('editor')}>
              <Code className="h-4 w-4" />
              {getOpenInDefaultLabel(
                'editor',
                preferences?.editor,
                preferences?.terminal
              )}
            </DropdownMenuItem>
          )}
          {canTerminal && (
            <DropdownMenuItem onSelect={() => openAction('terminal')}>
              <Terminal className="h-4 w-4" />
              {getOpenInDefaultLabel(
                'terminal',
                preferences?.editor,
                preferences?.terminal
              )}
            </DropdownMenuItem>
          )}
          {canFinder && (
            <DropdownMenuItem onSelect={() => openAction('finder')}>
              <FolderOpen className="h-4 w-4" />
              Finder
            </DropdownMenuItem>
          )}
          {branch && (
            <DropdownMenuItem onSelect={() => openAction('github')}>
              <Github className="h-4 w-4" />
              GitHub
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openPreferencesPane('general')}>
            <Settings className="h-4 w-4" />
            Change default...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
