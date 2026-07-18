/**
 * Headless jean-server self-update (Web Access only, user-triggered).
 *
 * Checks for a newer jean-server binary after the browser connects and shows a
 * toast. Install only happens when the user clicks "Update & restart".
 */

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'
import { logger } from '@/lib/logger'

export interface ServerUpdateStatus {
  updateAvailable: boolean
  currentVersion: string
  latestVersion?: string | null
  notes?: string | null
  canUpdate: boolean
  reason?: string | null
}

interface ServerUpdateApplyResult {
  success: boolean
  version: string
  message: string
  restartScheduled: boolean
}

function normalizeStatus(raw: Record<string, unknown>): ServerUpdateStatus {
  return {
    updateAvailable: Boolean(raw.updateAvailable ?? raw.update_available),
    currentVersion: String(raw.currentVersion ?? raw.current_version ?? ''),
    latestVersion: (raw.latestVersion ?? raw.latest_version ?? null) as
      | string
      | null,
    notes: (raw.notes ?? null) as string | null,
    canUpdate: Boolean(raw.canUpdate ?? raw.can_update),
    reason: (raw.reason ?? null) as string | null,
  }
}

export function useServerUpdateCheck() {
  const notifiedVersionRef = useRef<string | null>(null)

  const applyUpdate = useCallback(async (version: string) => {
    const toastId = toast.loading(`Installing jean-server ${version}...`)
    try {
      const result = await invoke<ServerUpdateApplyResult>(
        'apply_server_update'
      )
      toast.success(
        result.message || `Installed jean-server ${result.version}`,
        {
          id: toastId,
          description: result.restartScheduled
            ? 'The server is restarting. This page will reconnect automatically.'
            : undefined,
          duration: 12_000,
        }
      )
    } catch (error) {
      logger.error('Failed to apply jean-server update', { error })
      toast.error(`Update failed: ${String(error)}`, {
        id: toastId,
        duration: 10_000,
      })
    }
  }, [])

  const showUpdateToast = useCallback(
    (status: ServerUpdateStatus) => {
      if (!status.updateAvailable || !status.latestVersion) return
      if (notifiedVersionRef.current === status.latestVersion) return
      notifiedVersionRef.current = status.latestVersion

      const version = status.latestVersion
      if (!status.canUpdate) {
        toast.info(`jean-server ${version} is available`, {
          id: 'server-update-available',
          description:
            status.reason ||
            'This host cannot self-update. Replace the binary or image manually.',
          duration: Infinity,
        })
        return
      }

      toast.info(`jean-server ${version} is available`, {
        id: 'server-update-available',
        description: `You are on ${status.currentVersion}. Update installs the new binary and restarts the server.`,
        duration: Infinity,
        action: {
          label: 'Update & restart',
          onClick: () => {
            void applyUpdate(version)
          },
        },
      })
    },
    [applyUpdate]
  )

  useEffect(() => {
    if (isNativeApp()) return

    let cancelled = false

    const check = async () => {
      // Wait for WebSocket/backend to be ready.
      await new Promise(resolve => setTimeout(resolve, 8_000))
      if (cancelled) return
      try {
        const raw = await invoke<Record<string, unknown>>('check_server_update')
        if (cancelled) return
        showUpdateToast(normalizeStatus(raw ?? {}))
      } catch (error) {
        // Silent: offline / unsupported hosts / older servers without the command
        logger.debug('Server update check skipped', { error: String(error) })
      }
    }

    void check()

    return () => {
      cancelled = true
    }
  }, [showUpdateToast])
}
