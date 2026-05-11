/**
 * CLI Version Check Hook
 *
 * Checks for CLI updates on application startup and shows toast notifications.
 * Depending on the user's `auto_update_ai_backends` preference, updates are
 * either installed automatically in the background, or surfaced via a toast
 * with an "Update in background" action.
 */

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import {
  useClaudeCliStatus,
  useAvailableCliVersions,
  useClaudePathDetection,
  claudeCliQueryKeys,
} from '@/services/claude-cli'
import {
  useGhCliStatus,
  useAvailableGhVersions,
  useGhPathDetection,
  ghCliQueryKeys,
} from '@/services/gh-cli'
import {
  useCodexCliStatus,
  useAvailableCodexVersions,
  useCodexPathDetection,
  codexCliQueryKeys,
} from '@/services/codex-cli'
import {
  useOpencodeCliStatus,
  useAvailableOpencodeVersions,
  useOpencodePathDetection,
  opencodeCliQueryKeys,
} from '@/services/opencode-cli'
import { useUIStore } from '@/store/ui-store'
import { isNewerVersion } from '@/lib/version-utils'
import { logger } from '@/lib/logger'
import { hasBackend } from '@/lib/environment'
import { usePreferences } from '@/services/preferences'
import {
  CLI_DISPLAY_NAMES,
  resolveCliPathUpdateAction,
  type CliType,
} from '@/lib/cli-update'
import type { QueryClient } from '@tanstack/react-query'

interface CliUpdateInfo {
  type: CliType
  currentVersion: string
  latestVersion: string
  cliSource?: 'jean' | 'path'
  cliPath?: string | null
  packageManager?: string | null
}

const JEAN_INSTALL_COMMANDS: Record<CliType, string> = {
  claude: 'install_claude_cli',
  codex: 'install_codex_cli',
  opencode: 'install_opencode_cli',
  gh: 'install_gh_cli',
}

const CLI_QUERY_KEY_GETTERS: Record<CliType, () => readonly unknown[]> = {
  claude: () => claudeCliQueryKeys.all,
  codex: () => codexCliQueryKeys.all,
  opencode: () => opencodeCliQueryKeys.all,
  gh: () => ghCliQueryKeys.all,
}

/**
 * Resolve the effective CLI version/path/source by falling back to path detection
 * when the preference-based status shows the CLI is not installed (e.g. system-installed
 * Codex with default 'jean' preference → Jean binary missing → use path detection instead).
 */
function resolveCliInfo(
  status:
    | { installed: boolean; version?: string | null; path?: string | null }
    | undefined,
  pathInfo:
    | {
        found: boolean
        version?: string | null
        path?: string | null
        package_manager?: string | null
      }
    | undefined,
  preferredSource: 'jean' | 'path' | undefined
): {
  version: string | null
  path: string | null
  source: 'jean' | 'path'
  packageManager: string | null
} {
  if (status?.installed && status.version) {
    return {
      version: status.version,
      path: status.path ?? null,
      source: preferredSource ?? 'jean',
      packageManager: pathInfo?.package_manager ?? null,
    }
  }
  if (pathInfo?.found && pathInfo.version) {
    return {
      version: pathInfo.version,
      path: pathInfo.path ?? null,
      source: 'path',
      packageManager: pathInfo.package_manager ?? null,
    }
  }
  return { version: null, path: null, source: 'path', packageManager: null }
}

/**
 * Hook that checks for CLI updates on startup and periodically (every hour).
 * Shows toast notifications when updates are detected.
 * Should be called once in App.tsx.
 */
export function useCliVersionCheck() {
  const shouldCheck = hasBackend()
  const queryClient = useQueryClient()
  const { data: preferences, isLoading: preferencesLoading } = usePreferences()
  const { data: claudePathInfo } = useClaudePathDetection({
    enabled: shouldCheck,
  })
  const { data: ghPathInfo } = useGhPathDetection({ enabled: shouldCheck })
  const { data: codexPathInfo } = useCodexPathDetection({
    enabled: shouldCheck,
  })
  const { data: opencodePathInfo } = useOpencodePathDetection({
    enabled: shouldCheck,
  })

  // Defer version fetches (GitHub API) by 10s — they're only for update toasts,
  // no reason to compete with startup-critical queries.
  const [versionCheckReady, setVersionCheckReady] = useState(false)
  useEffect(() => {
    if (!shouldCheck) return
    const timer = setTimeout(() => setVersionCheckReady(true), 10_000)
    return () => clearTimeout(timer)
  }, [shouldCheck])

  const { data: claudeStatus, isLoading: claudeLoading } = useClaudeCliStatus({
    enabled: shouldCheck && versionCheckReady,
  })
  const { data: ghStatus, isLoading: ghLoading } = useGhCliStatus({
    enabled: shouldCheck && versionCheckReady,
  })
  const { data: codexStatus, isLoading: codexLoading } = useCodexCliStatus({
    enabled: shouldCheck && versionCheckReady,
  })
  const { data: opencodeStatus, isLoading: opencodeLoading } =
    useOpencodeCliStatus({ enabled: shouldCheck && versionCheckReady })
  const { data: claudeVersions, isLoading: claudeVersionsLoading } =
    useAvailableCliVersions({ enabled: shouldCheck && versionCheckReady })
  const { data: ghVersions, isLoading: ghVersionsLoading } =
    useAvailableGhVersions({ enabled: shouldCheck && versionCheckReady })
  const { data: codexVersions, isLoading: codexVersionsLoading } =
    useAvailableCodexVersions({ enabled: shouldCheck && versionCheckReady })
  const { data: opencodeVersions, isLoading: opencodeVersionsLoading } =
    useAvailableOpencodeVersions({ enabled: shouldCheck && versionCheckReady })

  // Track which update pairs we've already shown notifications/run installs for
  // Format: "type:currentVersion→latestVersion"
  const notifiedRef = useRef<Set<string>>(new Set())
  const isInitialCheckRef = useRef(true)

  useEffect(() => {
    // Wait until all data is loaded
    const isLoading =
      claudeLoading ||
      ghLoading ||
      codexLoading ||
      opencodeLoading ||
      claudeVersionsLoading ||
      ghVersionsLoading ||
      codexVersionsLoading ||
      opencodeVersionsLoading ||
      preferencesLoading
    if (isLoading) return

    const updates: CliUpdateInfo[] = []

    // Resolve effective CLI info (falls back to path detection when Jean binary is missing)
    const claude = resolveCliInfo(
      claudeStatus,
      claudePathInfo,
      preferences?.claude_cli_source
    )
    const gh = resolveCliInfo(ghStatus, ghPathInfo, preferences?.gh_cli_source)
    const codex = resolveCliInfo(
      codexStatus,
      codexPathInfo,
      preferences?.codex_cli_source
    )
    const opencode = resolveCliInfo(
      opencodeStatus,
      opencodePathInfo,
      preferences?.opencode_cli_source
    )

    const checks: {
      type: CliUpdateInfo['type']
      info: ReturnType<typeof resolveCliInfo>
      versions: { version: string; prerelease: boolean }[] | undefined
    }[] = [
      { type: 'claude', info: claude, versions: claudeVersions },
      { type: 'gh', info: gh, versions: ghVersions },
      { type: 'codex', info: codex, versions: codexVersions },
      { type: 'opencode', info: opencode, versions: opencodeVersions },
    ]

    for (const { type, info, versions } of checks) {
      if (!info.version || !versions?.length) continue
      const latestStable = versions.find(v => !v.prerelease)
      if (!latestStable || !isNewerVersion(latestStable.version, info.version))
        continue
      const key = `${type}:${info.version}→${latestStable.version}`
      if (notifiedRef.current.has(key)) continue
      notifiedRef.current.add(key)
      updates.push({
        type,
        currentVersion: info.version,
        latestVersion: latestStable.version,
        cliSource: info.source,
        cliPath: info.path,
        packageManager: info.packageManager,
      })
    }

    if (updates.length > 0) {
      logger.info('CLI updates available', { updates })
      const autoUpdate = preferences?.auto_update_ai_backends ?? true
      const handleUpdates = () => {
        if (autoUpdate) {
          for (const update of updates) {
            void runBackgroundUpdate(
              update,
              queryClient,
              true,
              notifiedRef.current
            )
          }
        } else {
          showUpdateToasts(updates, queryClient)
        }
      }

      if (isInitialCheckRef.current) {
        // Delay initial notification to let the app settle
        setTimeout(handleUpdates, 5000)
      } else {
        handleUpdates()
      }
    }

    isInitialCheckRef.current = false
  }, [
    claudeStatus,
    ghStatus,
    codexStatus,
    opencodeStatus,
    claudePathInfo,
    ghPathInfo,
    codexPathInfo,
    opencodePathInfo,
    claudeVersions,
    ghVersions,
    codexVersions,
    opencodeVersions,
    claudeLoading,
    ghLoading,
    codexLoading,
    opencodeLoading,
    claudeVersionsLoading,
    ghVersionsLoading,
    codexVersionsLoading,
    opencodeVersionsLoading,
    preferencesLoading,
    preferences?.auto_update_ai_backends,
    preferences?.claude_cli_source,
    preferences?.codex_cli_source,
    preferences?.opencode_cli_source,
    preferences?.gh_cli_source,
    queryClient,
  ])

  // Re-check CLI versions every hour so deferred updates retry once any
  // blocking sessions have stopped (or once a new release ships).
  useEffect(() => {
    if (!shouldCheck) return
    const id = setInterval(
      () => {
        queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.all })
        queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.all })
        queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.all })
        queryClient.invalidateQueries({ queryKey: opencodeCliQueryKeys.all })
      },
      60 * 60 * 1000
    )
    return () => clearInterval(id)
  }, [shouldCheck, queryClient])
}

/**
 * Show toast notifications for each CLI update.
 * The "Update" action runs the install in the background; failures fall back
 * to the existing modal flow so the user can see raw output.
 */
function showUpdateToasts(updates: CliUpdateInfo[], queryClient: QueryClient) {
  for (const update of updates) {
    const cliName = CLI_DISPLAY_NAMES[update.type]
    const toastId = `cli-update-${update.type}`

    toast.info(`${cliName} update available`, {
      id: toastId,
      description: `v${update.currentVersion} → v${update.latestVersion}`,
      duration: Infinity,
      action: {
        label: 'Update',
        onClick: () => {
          toast.dismiss(toastId)
          void runBackgroundUpdate(update, queryClient, false)
        },
      },
      cancel: {
        label: 'Cancel',
        onClick: () => {
          toast.dismiss(toastId)
        },
      },
    })
  }
}

/**
 * Detect the "active session" guard error so we can fall back to a manual toast
 * (giving the user a chance to stop sessions before retrying).
 */
function isActiveSessionConflict(message: string): boolean {
  return (
    message.startsWith('Cannot install') || message.startsWith('Cannot update')
  )
}

/**
 * Run a CLI update silently in the background, surfacing only a single
 * loading → success / error toast. Falls back to the appropriate manual flow
 * (modal or toast) when the install can't run silently.
 */
async function runBackgroundUpdate(
  update: CliUpdateInfo,
  queryClient: QueryClient,
  autoUpdate: boolean,
  notified?: Set<string>
) {
  const cliName = CLI_DISPLAY_NAMES[update.type]
  const toastId = `cli-update-bg-${update.type}`
  const versionKey = `${update.type}:${update.currentVersion}→${update.latestVersion}`

  const handleActiveSessionConflict = () => {
    toast.dismiss(toastId)
    if (autoUpdate) {
      // Auto-update is ON: silent skip. Allow retry on next hook tick.
      notified?.delete(versionKey)
      logger.info('Skipped silent CLI update: active sessions', {
        type: update.type,
      })
      return
    }
    showUpdateToasts([update], queryClient)
  }

  toast.loading(`Updating ${cliName}…`, {
    id: toastId,
    description: `v${update.currentVersion} → v${update.latestVersion}`,
    duration: Infinity,
  })

  try {
    if (update.cliSource === 'path') {
      const action = resolveCliPathUpdateAction(
        update.type,
        update.cliPath,
        update.packageManager,
        update.latestVersion
      )
      if (!action) {
        toast.error(
          `Can't auto-update ${cliName}. Update via your package manager.`,
          { id: toastId, duration: 8000 }
        )
        return
      }
      const [command, args] = action
      try {
        await invoke('run_cli_path_update', {
          command,
          args,
          cliType: update.type,
        })
      } catch (err) {
        const msg = String(err)
        logger.warn('Background path update failed', {
          type: update.type,
          msg,
        })
        if (isActiveSessionConflict(msg)) {
          handleActiveSessionConflict()
          return
        }
        toast.error(`Failed to update ${cliName}`, {
          id: toastId,
          description: msg,
          duration: Infinity,
          action: {
            label: 'Open terminal',
            onClick: () => {
              useUIStore
                .getState()
                .openCliLoginModal(update.type, command, args, 'update')
              toast.dismiss(toastId)
            },
          },
        })
        return
      }
    } else {
      const tauriCmd = JEAN_INSTALL_COMMANDS[update.type]
      try {
        await invoke(tauriCmd, { version: update.latestVersion })
      } catch (err) {
        const msg = String(err)
        logger.warn('Background jean-managed update failed', {
          type: update.type,
          msg,
        })
        if (isActiveSessionConflict(msg)) {
          handleActiveSessionConflict()
          return
        }
        toast.error(`Failed to update ${cliName}`, {
          id: toastId,
          description: msg,
          duration: Infinity,
          action: {
            label: 'Open installer',
            onClick: () => {
              useUIStore.getState().openCliUpdateModal(update.type)
              toast.dismiss(toastId)
            },
          },
        })
        return
      }
    }

    queryClient.invalidateQueries({
      queryKey: CLI_QUERY_KEY_GETTERS[update.type](),
    })
    toast.success(`${cliName} updated to v${update.latestVersion}`, {
      id: toastId,
      duration: 5000,
    })
  } catch (err) {
    logger.error('Unexpected background update error', {
      type: update.type,
      err,
    })
    toast.error(`Failed to update ${cliName}: ${String(err)}`, {
      id: toastId,
      duration: Infinity,
    })
  }
}
