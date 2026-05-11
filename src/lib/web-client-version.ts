import { toast } from 'sonner'
import { CLIENT_BUILD_INFO, CLIENT_WEB_BUILD_ID } from '@/lib/build-info'
import { isNativeApp } from '@/lib/environment'
import { logger } from '@/lib/logger'

interface ServerBuildInfo {
  webBuildId?: string | null
  appVersion?: string | null
}

let notifiedServerBuildId: string | null = null

/**
 * Warn browser-mode users when their loaded JS bundle is older than the
 * frontend currently served by Jean Web Access.
 */
export function checkWebClientVersion(serverInfo: ServerBuildInfo): boolean {
  if (isNativeApp()) return false

  const serverBuildId = serverInfo.webBuildId
  if (!serverBuildId || serverBuildId === CLIENT_WEB_BUILD_ID) return false

  if (notifiedServerBuildId === serverBuildId) return true
  notifiedServerBuildId = serverBuildId

  logger.warn('Stale web access client detected', {
    clientBuildId: CLIENT_WEB_BUILD_ID,
    serverBuildId,
    clientVersion: CLIENT_BUILD_INFO.appVersion,
    serverVersion: serverInfo.appVersion,
  })

  toast.warning('Jean was updated', {
    id: 'web-client-stale',
    description: serverInfo.appVersion
      ? `Reload Web Access to use Jean ${serverInfo.appVersion} and the latest features.`
      : 'Reload Web Access to use the latest features.',
    duration: Infinity,
    closeButton: false,
    action: {
      label: 'Reload',
      onClick: () => window.location.reload(),
    },
  })

  return true
}
