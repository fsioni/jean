import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle,
  Copy,
  Loader2,
  PlugZap,
  ShieldAlert,
  XCircle,
} from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { BackendLabel } from '@/components/ui/backend-label'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/transport'
import { copyToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  useAllBackendsMcpServers,
  invalidateAllMcpServers,
  getNewServersToAutoEnable,
  useAllBackendsMcpHealth,
  groupServersByBackend,
  mcpKey,
  migrateLegacyMcpKeys,
} from '@/services/mcp'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useChatStore } from '@/store/chat-store'
import type { McpHealthStatus } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'

interface JeanMcpSnippet {
  enabled: boolean
  server_running: boolean
  mode: 'dev' | 'prod'
  server_name: string
  url: string | null
  token: string | null
  claude: string | null
  cursor: string | null
  codex_toml: string | null
  opencode_json: string | null
}

interface JeanMcpInstallResult {
  backend: CliBackend
  status: 'installed' | 'error'
  path: string | null
  backupPath: string | null
  serverName: string
  mode: 'dev' | 'prod'
  message: string
}

interface InstallFeedback {
  type: 'success' | 'error' | 'pending'
  message: string
}

const JeanMcpSection: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const { installedBackends } = useInstalledBackends()
  const [snippet, setSnippet] = useState<JeanMcpSnippet | null>(null)
  const [isInstalling, setIsInstalling] = useState(false)
  const [installFeedback, setInstallFeedback] =
    useState<InstallFeedback | null>(null)
  const [showInstallChoice, setShowInstallChoice] = useState(false)
  const [pendingAutoInstall, setPendingAutoInstall] = useState(false)
  const installFeedbackTimeoutRef = useRef<number | null>(null)

  const refreshSnippet = useCallback(async () => {
    try {
      const result = await invoke<JeanMcpSnippet>('get_jean_mcp_config_snippet')
      setSnippet(result)
    } catch (e) {
      console.error('Failed to load Jean MCP snippet', e)
    }
  }, [])

  useEffect(() => {
    refreshSnippet()
  }, [refreshSnippet, preferences?.jean_mcp_enabled])

  useEffect(() => {
    return () => {
      if (installFeedbackTimeoutRef.current !== null) {
        window.clearTimeout(installFeedbackTimeoutRef.current)
      }
    }
  }, [])

  const showInstallFeedback = useCallback((feedback: InstallFeedback) => {
    if (installFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(installFeedbackTimeoutRef.current)
    }
    setInstallFeedback(feedback)
    installFeedbackTimeoutRef.current = window.setTimeout(() => {
      setInstallFeedback(null)
      installFeedbackTimeoutRef.current = null
    }, 5000)
  }, [])

  const enabled = preferences?.jean_mcp_enabled ?? false
  const serverRunning = snippet?.server_running ?? false
  const mode = snippet?.mode ?? 'prod'
  const modeLabel = mode === 'dev' ? 'Dev' : 'Prod'
  const installableBackends = installedBackends.filter(
    backend =>
      backend === 'claude' ||
      backend === 'codex' ||
      backend === 'opencode' ||
      backend === 'cursor'
  )

  useEffect(() => {
    if (!enabled || serverRunning) return
    const interval = window.setInterval(refreshSnippet, 1000)
    return () => window.clearInterval(interval)
  }, [enabled, refreshSnippet, serverRunning])

  useEffect(() => {
    if (!pendingAutoInstall || !enabled || !serverRunning || isInstalling) {
      return
    }

    setPendingAutoInstall(false)
    handleInstall()
  }, [enabled, isInstalling, pendingAutoInstall, serverRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = (label: string, content: string | null) => {
    if (!content) {
      toast.error(`No ${label} snippet available — enable Jean MCP stdio first`)
      return
    }
    copyToClipboard(content)
    toast.success(`${label} snippet copied`)
  }

  const handleInstall = async (options?: { assumeEnabled?: boolean }) => {
    setInstallFeedback(null)
    setPendingAutoInstall(false)

    if ((!enabled && !options?.assumeEnabled) || !serverRunning) {
      showInstallFeedback({
        type: 'error',
        message: 'Enable Jean MCP first',
      })
      return
    }
    if (installableBackends.length === 0) {
      showInstallFeedback({
        type: 'error',
        message: 'Install Claude, Codex, OpenCode, or Cursor first',
      })
      return
    }

    setIsInstalling(true)
    try {
      const results = await invoke<JeanMcpInstallResult[]>(
        'install_jean_mcp_config',
        {
          backends: installableBackends,
          mode: 'current',
        }
      )
      const successes = results.filter(r => r.status === 'installed')
      const failures = results.filter(r => r.status === 'error')
      invalidateAllMcpServers(undefined, installableBackends)
      await refreshSnippet()

      if (failures.length > 0) {
        showInstallFeedback({
          type: 'error',
          message: `Added ${successes.length}/${results.length}; ${failures.length} failed`,
        })
      } else {
        showInstallFeedback({
          type: 'success',
          message: 'Added',
        })
      }
    } catch (e) {
      showInstallFeedback({
        type: 'error',
        message: 'Failed to add Jean MCP',
      })
      console.error('Failed to add Jean MCP config', e)
    } finally {
      setIsInstalling(false)
    }
  }

  const handleEnabledChange = (checked: boolean) => {
    patchPreferences.mutate({ jean_mcp_enabled: checked })
    setInstallFeedback(null)
    setPendingAutoInstall(false)
    if (checked) {
      setShowInstallChoice(true)
    } else {
      setShowInstallChoice(false)
    }
  }

  const handleAddAutomatically = () => {
    setShowInstallChoice(false)
    if (serverRunning) {
      handleInstall({ assumeEnabled: true })
      return
    }

    setPendingAutoInstall(true)
    showInstallFeedback({
      type: 'pending',
      message: 'Waiting for MCP...',
    })
  }

  return (
    <>
      <SettingsSection title="Jean MCP Server" anchorId="pref-mcp-section-jean">
      <p className="text-sm text-muted-foreground">
        Expose Jean&apos;s own commands over MCP so spawned local CLIs can call
        back into Jean (create worktrees, list GitHub issues, send chat
        messages, etc).
      </p>
      <div className="flex items-center gap-3 rounded-md border px-4 py-3">
        <Switch
          id="jean-mcp-enabled"
          checked={enabled}
          onCheckedChange={handleEnabledChange}
        />
        <Label htmlFor="jean-mcp-enabled" className="flex-1 cursor-pointer">
          Enable Jean MCP stdio
        </Label>
        {!serverRunning && enabled && (
          <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <PlugZap className="size-3.5" />
            MCP stdio socket not running
          </span>
        )}
      </div>

      {enabled && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="jean-mcp-max-depth" className="text-xs">
                Max recursion depth
              </Label>
              <Input
                id="jean-mcp-max-depth"
                type="number"
                min={0}
                max={10}
                value={preferences?.jean_mcp_max_depth ?? 3}
                onChange={e =>
                  patchPreferences.mutate({
                    jean_mcp_max_depth: Math.max(
                      0,
                      Math.min(10, Number(e.target.value) || 0)
                    ),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jean-mcp-rate-limit" className="text-xs">
                Spawn rate limit (per minute)
              </Label>
              <Input
                id="jean-mcp-rate-limit"
                type="number"
                min={0}
                max={1000}
                value={preferences?.jean_mcp_rate_limit_per_minute ?? 20}
                onChange={e =>
                  patchPreferences.mutate({
                    jean_mcp_rate_limit_per_minute: Math.max(
                      0,
                      Math.min(1000, Number(e.target.value) || 0)
                    ),
                  })
                }
              />
            </div>
          </div>

          <div className="space-y-2 rounded-md border px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <Label className="text-sm font-medium">
                  One-click config install
                </Label>
                <p className="text-xs text-muted-foreground">
                  Safely merges Jean MCP config into
                  the CLI user configs.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => handleInstall()}
                disabled={
                  isInstalling ||
                  installFeedback?.type === 'success' ||
                  !serverRunning ||
                  installableBackends.length === 0
                }
                className={cn(
                  'min-w-[11rem] max-w-[18rem]',
                  installFeedback?.type === 'success' &&
                    'border-green-600 bg-green-600 text-white hover:bg-green-700'
                )}
                aria-live="polite"
                title={installFeedback?.message}
              >
                {isInstalling ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    <span>Adding...</span>
                  </>
                ) : installFeedback?.type === 'success' ? (
                  <>
                    <CheckCircle className="size-3.5" />
                    <span className="truncate">{installFeedback.message}</span>
                  </>
                ) : installFeedback?.type === 'pending' ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    <span className="truncate">{installFeedback.message}</span>
                  </>
                ) : installFeedback?.type === 'error' ? (
                  <>
                    <XCircle className="size-3.5" />
                    <span className="truncate">{installFeedback.message}</span>
                  </>
                ) : (
                  <span>Add current Jean MCP ({modeLabel})</span>
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Manual setup snippets
            </Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCopy('Claude', snippet?.claude ?? null)}
              >
                <Copy className="mr-2 size-3.5" />
                Claude (~/.claude.json)
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCopy('Cursor', snippet?.cursor ?? null)}
              >
                <Copy className="mr-2 size-3.5" />
                Cursor (~/.cursor/mcp.json)
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCopy('Codex', snippet?.codex_toml ?? null)}
              >
                <Copy className="mr-2 size-3.5" />
                Codex (~/.codex/config.toml)
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  handleCopy('OpenCode', snippet?.opencode_json ?? null)
                }
              >
                <Copy className="mr-2 size-3.5" />
                OpenCode (~/.config/opencode/opencode.json)
              </Button>
            </div>
          </div>
        </>
      )}
      </SettingsSection>

      <AlertDialog open={showInstallChoice} onOpenChange={setShowInstallChoice}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add Jean MCP to your CLI configs?</AlertDialogTitle>
            <AlertDialogDescription>
              Jean MCP is enabled. Jean can add it automatically to your
              installed CLI config files, or you can copy the manual snippets
              below.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Manual setup</AlertDialogCancel>
            <AlertDialogAction onClick={handleAddAutomatically}>
              Add automatically
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function mcpAuthHint(backend: CliBackend): string {
  switch (backend) {
    case 'codex':
      return "Run 'codex mcp auth' in your terminal to authenticate"
    case 'opencode':
      return "Run 'opencode mcp auth' in your terminal to authenticate"
    case 'cursor':
      return "Run 'cursor-agent mcp login <server>' in your terminal to authenticate"
    default:
      return "Run 'claude /mcp' in your terminal to authenticate"
  }
}

function HealthIndicator({
  status,
  isChecking,
  backend,
}: {
  status: McpHealthStatus | undefined
  isChecking: boolean
  backend: CliBackend
}) {
  if (isChecking) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        checking...
      </span>
    )
  }

  if (!status) return null

  switch (status) {
    case 'connected':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="size-3.5" />
              connected
            </span>
          </TooltipTrigger>
          <TooltipContent>Server is connected and ready</TooltipContent>
        </Tooltip>
      )
    case 'needsAuthentication':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <ShieldAlert className="size-3.5" />
              needs auth
            </span>
          </TooltipTrigger>
          <TooltipContent>{mcpAuthHint(backend)}</TooltipContent>
        </Tooltip>
      )
    case 'couldNotConnect':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
              <XCircle className="size-3.5" />
              connection failed
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Could not connect -- check that the server is running
          </TooltipContent>
        </Tooltip>
      )
    case 'disabled':
      return null
    default:
      return null
  }
}

function jeanMcpMode(
  serverName: string,
  config: unknown
): 'dev' | 'prod' | null {
  if (serverName === 'jean-dev') return 'dev'
  if (serverName === 'jean') return 'prod'
  if (!config || typeof config !== 'object') return null
  const record = config as Record<string, unknown>
  const env =
    record.env && typeof record.env === 'object'
      ? (record.env as Record<string, unknown>)
      : record.environment && typeof record.environment === 'object'
        ? (record.environment as Record<string, unknown>)
        : null
  const mode = env?.JEAN_MCP_MODE
  return mode === 'dev' || mode === 'prod' ? mode : null
}

export const McpServersPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const { installedBackends } = useInstalledBackends()

  // Get worktree path for project-scope discovery
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const { data: mcpServers, isLoading } = useAllBackendsMcpServers(
    activeWorktreePath,
    installedBackends
  )

  // Health check — triggered on mount and when backends change
  const {
    statuses: healthStatuses,
    isFetching: isHealthChecking,
    refetchAll: checkHealth,
  } = useAllBackendsMcpHealth(installedBackends, activeWorktreePath)

  // Re-read MCP config from disk and trigger health check every time this pane is opened
  useEffect(() => {
    invalidateAllMcpServers(undefined, installedBackends)
    checkHealth()
  }, [checkHealth, installedBackends])

  const enabledServers = preferences?.default_enabled_mcp_servers ?? []
  const knownServers = preferences?.known_mcp_servers ?? []

  // Auto-enable newly discovered (non-disabled) servers, but not ones the user has previously disabled
  useEffect(() => {
    if (!preferences || !mcpServers) return

    // Migrate legacy bare-name keys to composite keys
    let currentEnabled = enabledServers
    let currentKnown = knownServers
    const enabledMigration = migrateLegacyMcpKeys(enabledServers, mcpServers)
    const knownMigration = migrateLegacyMcpKeys(knownServers, mcpServers)
    if (enabledMigration.changed) currentEnabled = enabledMigration.migrated
    if (knownMigration.changed) currentKnown = knownMigration.migrated

    const allServerKeys = mcpServers
      .filter(s => !s.disabled)
      .map(s => mcpKey(s.backend, s.name))
    const newServers = getNewServersToAutoEnable(
      mcpServers,
      currentEnabled,
      currentKnown
    )
    const updatedKnown = [...new Set([...currentKnown, ...allServerKeys])]
    const knownChanged = updatedKnown.length !== currentKnown.length

    if (
      newServers.length > 0 ||
      knownChanged ||
      enabledMigration.changed ||
      knownMigration.changed
    ) {
      patchPreferences.mutate({
        default_enabled_mcp_servers: [...currentEnabled, ...newServers],
        known_mcp_servers: updatedKnown,
      })
    }
  }, [mcpServers]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = (backend: CliBackend, serverName: string) => {
    if (!preferences) return
    const key = mcpKey(backend, serverName)
    const updated = enabledServers.includes(key)
      ? enabledServers.filter(n => n !== key)
      : [...enabledServers, key]
    patchPreferences.mutate({ default_enabled_mcp_servers: updated })
  }

  const grouped = groupServersByBackend(mcpServers ?? [])
  const backendsWithServers = installedBackends.filter(
    b => grouped[b] && grouped[b].length > 0
  )
  const showSectionHeaders = backendsWithServers.length > 1

  return (
    <div className="space-y-6">
      <JeanMcpSection />
      <SettingsSection
        title="Default MCP Servers"
        anchorId="pref-mcp-section-default-servers"
      >
        <p className="text-sm text-muted-foreground">
          Selected servers will be enabled by default in new sessions. You can
          override per-session from the toolbar.
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading MCP servers...
          </div>
        ) : !mcpServers || mcpServers.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground">
            No MCP servers found across installed backends.
          </div>
        ) : (
          <div className="space-y-4">
            {backendsWithServers.map(backend => (
              <div key={backend} className="space-y-2">
                {showSectionHeaders && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <BackendLabel backend={backend} />
                    </span>
                    <Separator className="flex-1" />
                  </div>
                )}
                {(grouped[backend] ?? []).map(server => (
                  <div
                    key={`${backend}-${server.name}`}
                    className={cn(
                      'flex items-center gap-3 rounded-md border px-4 py-3',
                      server.disabled && 'opacity-50'
                    )}
                  >
                    <Checkbox
                      id={`mcp-${backend}-${server.name}`}
                      checked={
                        !server.disabled &&
                        enabledServers.includes(mcpKey(backend, server.name))
                      }
                      onCheckedChange={() => handleToggle(backend, server.name)}
                      disabled={server.disabled}
                    />
                    <Label
                      htmlFor={`mcp-${backend}-${server.name}`}
                      className={cn(
                        'flex-1 text-sm font-medium',
                        server.disabled ? 'cursor-default' : 'cursor-pointer'
                      )}
                    >
                      {server.name}
                    </Label>
                    {jeanMcpMode(server.name, server.config) && (
                      <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                        {jeanMcpMode(server.name, server.config)}
                      </span>
                    )}
                    <HealthIndicator
                      status={healthStatuses[mcpKey(backend, server.name)]}
                      isChecking={isHealthChecking}
                      backend={backend}
                    />
                    <span className="text-xs text-muted-foreground">
                      {server.disabled ? 'disabled' : server.scope}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
