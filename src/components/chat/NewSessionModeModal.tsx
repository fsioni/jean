import { useCallback, useEffect, useMemo } from 'react'
import { MessageSquarePlus, Loader2, Terminal } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { useCreateSession } from '@/services/chat'
import { useClaudeCliStatus } from '@/services/claude-cli'
import { useCodexCliStatus } from '@/services/codex-cli'
import { useOpencodeCliStatus } from '@/services/opencode-cli'
import { useCursorCliStatus } from '@/services/cursor-cli'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import {
  getBackendIcon,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'
import type { CliBackend } from '@/types/preferences'

const BACKEND_ORDER: CliBackend[] = ['codex', 'claude', 'opencode', 'cursor']

const backendCommands: Record<CliBackend, string> = {
  codex: 'codex',
  claude: 'claude',
  opencode: 'opencode',
  cursor: 'cursor-agent',
}

export function NewSessionModeModal() {
  const target = useUIStore(state => state.newSessionModeTarget)
  const close = useUIStore(state => state.closeNewSessionModeModal)
  const createSession = useCreateSession()
  const claudeStatus = useClaudeCliStatus({ enabled: target !== null })
  const codexStatus = useCodexCliStatus({ enabled: target !== null })
  const opencodeStatus = useOpencodeCliStatus({ enabled: target !== null })
  const cursorStatus = useCursorCliStatus({ enabled: target !== null })
  const open = target !== null

  const installedBackendChoices = useMemo(
    () =>
      BACKEND_ORDER.map((backend, index) => {
        const status =
          backend === 'codex'
            ? codexStatus
            : backend === 'claude'
              ? claudeStatus
              : backend === 'opencode'
                ? opencodeStatus
                : cursorStatus
        return {
          backend,
          shortcut: String(index + 2),
          installed: Boolean(status.data?.installed),
          command: status.data?.path ?? backendCommands[backend],
        }
      }).filter(choice => choice.installed),
    [
      claudeStatus.data?.installed,
      claudeStatus.data?.path,
      codexStatus.data?.installed,
      codexStatus.data?.path,
      cursorStatus.data?.installed,
      cursorStatus.data?.path,
      opencodeStatus.data?.installed,
      opencodeStatus.data?.path,
    ]
  )

  const isCheckingBackends =
    claudeStatus.isLoading ||
    codexStatus.isLoading ||
    opencodeStatus.isLoading ||
    cursorStatus.isLoading

  const openSessionModal = useCallback(
    (sessionId: string, worktreeId: string, worktreePath: string) => {
      if (!target) return
      if (target.origin === 'canvas') {
        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: { sessionId, worktreeId, worktreePath },
          })
        )
      } else if (target.origin === 'modal') {
        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: { sessionId },
          })
        )
      }
    },
    [target]
  )

  const chooseChat = useCallback(() => {
    if (!target) return
    const { worktreeId, worktreePath } = target
    close()
    createSession.mutate(
      { worktreeId, worktreePath },
      {
        onSuccess: session => {
          useChatStore.getState().setActiveSession(worktreeId, session.id)
          useUIStore.getState().setSessionPrimarySurface(session.id, 'chat')
          openSessionModal(session.id, worktreeId, worktreePath)
        },
      }
    )
  }, [close, createSession, openSessionModal, target])

  const choosePlainTerminal = useCallback(() => {
    if (!target) return
    const { worktreeId, worktreePath } = target
    close()
    createSession.mutate(
      { worktreeId, worktreePath, name: 'Terminal' },
      {
        onSuccess: session => {
          const terminalId = useTerminalStore
            .getState()
            .addTerminal(worktreeId, null, session.name, {
              kind: 'session',
              commandArgs: [],
              activate: false,
              openPanel: false,
            })

          const uiStore = useUIStore.getState()
          uiStore.setSessionPrimarySurface(session.id, 'terminal')
          uiStore.setSessionTerminalId(session.id, terminalId)
          useChatStore.getState().setActiveSession(worktreeId, session.id)
          openSessionModal(session.id, worktreeId, worktreePath)
        },
      }
    )
  }, [close, createSession, openSessionModal, target])

  const chooseBackendTerminal = useCallback(
    (backend: CliBackend) => {
      if (!target) return
      const { worktreeId, worktreePath } = target
      const command =
        installedBackendChoices.find(choice => choice.backend === backend)
          ?.command ?? backendCommands[backend]
      const label = getBackendPlainLabel(backend)
      close()
      createSession.mutate(
        { worktreeId, worktreePath, name: label, backend },
        {
          onSuccess: session => {
            const terminalStore = useTerminalStore.getState()
            const terminalId = terminalStore.addTerminal(
              worktreeId,
              command,
              session.name,
              {
                kind: 'session',
                commandArgs: [],
                activate: false,
                openPanel: false,
              }
            )

            const uiStore = useUIStore.getState()
            uiStore.setSessionPrimarySurface(session.id, 'terminal')
            uiStore.setSessionTerminalId(session.id, terminalId)
            const chatStore = useChatStore.getState()
            chatStore.setActiveSession(worktreeId, session.id)
            chatStore.setSelectedBackend(session.id, backend)
            openSessionModal(session.id, worktreeId, worktreePath)
          },
        }
      )
    },
    [close, createSession, installedBackendChoices, openSessionModal, target]
  )

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        chooseChat()
        return
      }

      if (event.key === '1') {
        event.preventDefault()
        event.stopPropagation()
        choosePlainTerminal()
        return
      }

      const choice = installedBackendChoices.find(
        item => item.shortcut === event.key
      )
      if (choice) {
        event.preventDefault()
        event.stopPropagation()
        chooseBackendTerminal(choice.backend)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [
    chooseBackendTerminal,
    chooseChat,
    choosePlainTerminal,
    installedBackendChoices,
    open,
  ])

  return (
    <Dialog open={open} onOpenChange={nextOpen => !nextOpen && close()}>
      <DialogContent className="w-[min(420px,calc(100vw-32px))] gap-3 p-4 sm:max-w-[420px]">
        <DialogHeader className="space-y-1 pr-6">
          <DialogTitle className="text-base font-semibold">
            New session
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">
            Choose what to open for this worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 gap-2">
          <NewSessionChoice
            icon={
              createSession.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MessageSquarePlus className="size-4" />
              )
            }
            title="Jean Chat"
            subtitle="Normal ChatWindow session with Jean features"
            badge="Default"
            shortcut="↵"
            disabled={createSession.isPending}
            onClick={chooseChat}
          />

          <NewSessionChoice
            icon={<Terminal className="size-4" />}
            title="Terminal"
            subtitle="Open a plain terminal on this worktree"
            shortcut="1"
            disabled={createSession.isPending}
            onClick={choosePlainTerminal}
          />

          <div
            aria-hidden="true"
            data-testid="new-session-backend-separator"
            className="my-1 h-px bg-border/70"
          />

          {installedBackendChoices.map(choice => {
            const Icon = getBackendIcon(choice.backend)
            const label = getBackendPlainLabel(choice.backend)
            return (
              <NewSessionChoice
                key={choice.backend}
                icon={<Icon className="size-4" />}
                title={label}
                subtitle={`Open native ${label} in a terminal session`}
                shortcut={choice.shortcut}
                disabled={createSession.isPending}
                onClick={() => chooseBackendTerminal(choice.backend)}
              />
            )
          })}

          {isCheckingBackends && installedBackendChoices.length === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Checking installed backends…
            </div>
          )}

          {!isCheckingBackends && installedBackendChoices.length === 0 && (
            <div className="rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-xs text-muted-foreground">
              No installed backend CLIs found.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NewSessionChoice({
  icon,
  title,
  subtitle,
  badge,
  shortcut,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  badge?: string
  shortcut: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full min-w-0 max-w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-left transition-colors',
        'hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-muted/25'
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium leading-none">
          {title}
          {badge && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      </span>
      <Kbd className="shrink-0 text-[10px]">{shortcut}</Kbd>
    </button>
  )
}
