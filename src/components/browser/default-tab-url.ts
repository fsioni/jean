import type { PortEntry } from '@/services/projects'

/**
 * Resolve the URL a freshly opened browser tab should load.
 * Prefers the first jean.json-configured port (`http://<host>:<port>`)
 * so the embedded browser auto-points at the worktree's dev server.
 * Falls back to about:blank when no port is configured.
 */
export function resolvePortUrl(port: PortEntry): string {
  const host = port.host?.trim() || 'localhost'
  return `http://${host}:${port.port}`
}

export function resolveDefaultTabUrl(ports: PortEntry[] | undefined): string {
  const first = ports?.[0]
  if (!first) return 'about:blank'
  return resolvePortUrl(first)
}
