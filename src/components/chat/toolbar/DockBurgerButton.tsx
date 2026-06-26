import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  Command,
  LayoutDashboard,
  Menu,
  Plug,
  Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { usePreferences } from '@/services/preferences'
import {
  useCodexCliAuth,
  useCodexCliStatus,
  useCodexUsage,
} from '@/services/codex-cli'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import type { CliBackend } from '@/types/preferences'

interface DockBurgerButtonProps {
  /** Number of enabled MCP servers; shown as a badge next to the MCP item. */
  activeMcpCount?: number
  /** Extra classes merged onto the trigger button (e.g. responsive visibility). */
  className?: string
}

export function DockBurgerButton({
  activeMcpCount = 0,
  className,
}: DockBurgerButtonProps = {}) {
  const isMobile = useIsMobile()
  const { data: preferences } = usePreferences()

  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const sessionChatModalOpen = useUIStore(state => state.sessionChatModalOpen)
  const sessionChatModalWorktreeId = useUIStore(
    state => state.sessionChatModalWorktreeId
  )
  const currentWorktreeId = sessionChatModalOpen
    ? (sessionChatModalWorktreeId ?? activeWorktreeId ?? selectedWorktreeId)
    : (activeWorktreeId ?? selectedWorktreeId)
  const activeSessionId = useChatStore(state =>
    currentWorktreeId ? state.activeSessionIds[currentWorktreeId] : undefined
  )
  const selectedBackend = useChatStore(state =>
    activeSessionId ? state.selectedBackends[activeSessionId] : undefined
  )

  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const activeBackend = (selectedBackend ??
    preferences?.default_backend ??
    'claude') as CliBackend

  const codexStatus = useCodexCliStatus()
  const codexAuth = useCodexCliAuth({
    enabled: !!codexStatus.data?.installed,
  })
  const codexUsage = useCodexUsage({
    enabled:
      !!codexStatus.data?.installed &&
      !!codexAuth.data?.authenticated &&
      menuOpen,
  })

  const codexAvailable =
    !!codexStatus.data?.installed && !!codexAuth.data?.authenticated
  const showCodexUsage = activeBackend === 'codex' && codexAvailable
  const sessionPct = codexUsage.data?.session?.usedPercent ?? null
  const weeklyPct = codexUsage.data?.weekly?.usedPercent ?? null
  const planText =
    codexUsage.data?.planType && codexUsage.data.planType.trim().length > 0
      ? codexUsage.data.planType
      : '--'
  const sessionText = sessionPct === null ? '--' : `${Math.round(sessionPct)}`
  const weeklyText = weeklyPct === null ? '--' : `${Math.round(weeklyPct)}`

  const toggleMenu = useCallback(() => {
    setMenuOpen(prev => !prev)
  }, [])

  // Global shortcut — only respond when this instance is the visible variant.
  // Both desktop + mobile burgers mount; CSS (`hidden`/`@xl:hidden`) hides one.
  // `offsetParent === null` is true for `display: none`, so the hidden variant skips.
  useEffect(() => {
    const handler = () => {
      if (!triggerRef.current || triggerRef.current.offsetParent === null)
        return
      toggleMenu()
    }
    window.addEventListener('toggle-quick-menu', handler)
    return () => window.removeEventListener('toggle-quick-menu', handler)
  }, [toggleMenu])

  const githubShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_github_dashboard ??
      DEFAULT_KEYBINDINGS.open_github_dashboard) as string
  )
  const menuShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_quick_menu ??
      DEFAULT_KEYBINDINGS.open_quick_menu) as string
  )

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={`Menu (${menuShortcut})`}
              className={cn(
                'flex h-8 items-center gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground',
                className
              )}
            >
              <Menu className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Menu ({menuShortcut})</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        className="min-w-[240px]"
        onEscapeKeyDown={e => e.stopPropagation()}
      >
        <DropdownMenuItem
          onClick={() =>
            useProjectsStore.getState().setAddProjectDialogOpen(true)
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Project
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            window.dispatchEvent(new CustomEvent('command:open-archived-modal'))
          }
        >
          <Archive className="mr-2 h-4 w-4" />
          Archives
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}
        >
          <Command className="mr-2 h-4 w-4" />
          Command Palette
          {!isMobile && <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => useUIStore.getState().setGitHubDashboardOpen(true)}
        >
          <LayoutDashboard className="mr-2 h-4 w-4" />
          GitHub Dashboard
          {!isMobile && (
            <DropdownMenuShortcut>{githubShortcut}</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() =>
            useUIStore.getState().openPreferencesPane('mcp-servers')
          }
        >
          <Plug
            className={
              activeMcpCount > 0
                ? 'mr-2 h-4 w-4 text-emerald-600 dark:text-emerald-400'
                : 'mr-2 h-4 w-4'
            }
          />
          MCP Servers
          {activeMcpCount > 0 && (
            <DropdownMenuShortcut>{activeMcpCount}</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>

        {!isMobile && showCodexUsage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">
              Codex usage · Plan: {planText}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => useUIStore.getState().openPreferencesPane('usage')}
            >
              Session | Weekly
              <DropdownMenuShortcut>
                {sessionText}|{weeklyText}%
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
