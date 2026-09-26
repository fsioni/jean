import { toast } from 'sonner'
import { isLocalBackend, isNativeApp } from '@/lib/environment'
import { openExternal } from '@/lib/platform'
import { parseServerResourceKey } from '@/lib/server-resource'
import {
  convertProjectFileSrc,
  convertServerProjectFileSrc,
  invoke,
} from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i
const LINE_SUFFIX = /:\d+(?::\d+)?$/

/**
 * Detect inline-code text that names a file, e.g. `.showreel/out/x.mp4`,
 * `src/main.ts:42` or `C:\repo\file.txt`. Returns the path without a
 * trailing `:line[:col]`, or null when the text is not a file path.
 */
export function extractFilePath(text: string): string | null {
  const value = text.trim().replace(LINE_SUFFIX, '')
  if (!value || /\s/.test(value)) return null
  if (URL_SCHEME.test(value) && !WINDOWS_ABSOLUTE.test(value)) return null
  if (!/[\\/]/.test(value)) return null
  const name = value.split(/[\\/]/).pop() ?? ''
  return /^[^.].*\.[a-z\d]+$|^\.[^.]+$/i.test(name) ? value : null
}

/** Resolve a relative path against the active worktree. */
export function resolveWorktreeFilePath(
  path: string,
  rootPath = useChatStore.getState().activeWorktreePath
): string | null {
  const isAbsolute = path.startsWith('/') || WINDOWS_ABSOLUTE.test(path)
  if (isAbsolute) return path
  if (!rootPath) return null
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${path.replace(/^(\.[\\/])?[\\/]*/, '')}`
}

/**
 * Download a file from the active worktree's server.
 * - Local native app: native "Save as" dialog, then copy on disk.
 * - Web access / remote server: authenticated project-file URL with
 *   `download=true`, so the server sends `Content-Disposition: attachment`.
 */
export async function downloadLocalFile(path: string): Promise<void> {
  const { activeWorktreeId } = useChatStore.getState()
  const serverId = parseServerResourceKey(activeWorktreeId ?? '')?.serverId
  const isRemoteServer = Boolean(serverId && serverId !== 'local')

  if (!isRemoteServer && isLocalBackend()) {
    const saved = await invoke<boolean>('save_file_as', { sourcePath: path })
    if (saved) toast.success('File saved')
    return
  }

  const fileUrl = isRemoteServer
    ? convertServerProjectFileSrc(serverId, path)
    : convertProjectFileSrc(path)
  const url = `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=true`

  if (isNativeApp()) {
    // The system browser handles the download for remote servers.
    await openExternal(url)
    return
  }

  // A new tab keeps the app open if the server returns an error page.
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.click()
}
