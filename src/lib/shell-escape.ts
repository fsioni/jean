/**
 * Construct a shell command string with proper path escaping for the current platform.
 *
 * - Windows (PowerShell): `& "path" args`
 * - Unix (sh/zsh/bash):   `'path' args`  (with internal single-quote escaping)
 */
import { isServerWindows } from './platform'

export function escapeCliCommand(path: string, args?: string): string {
  if (isServerWindows()) {
    return args ? `& "${path}" ${args}` : `& "${path}"`
  }
  const escaped = `'${path.replace(/'/g, "'\\''")}'`
  return args ? `${escaped} ${args}` : escaped
}
