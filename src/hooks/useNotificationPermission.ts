import { useEffect } from 'react'
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'
import { isTauri } from '@/services/projects'
import { logger } from '@/lib/logger'

/**
 * Ensures the OS notification permission is resolved at app startup.
 *
 * The Jenkins poller fires native notifications from Rust (`.notification()…
 * .show()`), which bypasses the JS permission gate — so on platforms that
 * enforce it (notably macOS), a never-granted permission silently swallows
 * every notification. Requesting once on startup makes the channel reliable and
 * is the front half of the notif-diagnostic (cause E).
 *
 * Native app only — `isTauri()` is false in web access, where the plugin and
 * OS notifications are not available.
 */
export function useNotificationPermission() {
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false

    void (async () => {
      try {
        let granted = await isPermissionGranted()
        if (!granted) {
          granted = (await requestPermission()) === 'granted'
        }
        if (!cancelled) {
          logger.debug('Notification permission resolved', { granted })
        }
      } catch (error) {
        logger.warn('Failed to resolve notification permission', { error })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])
}
