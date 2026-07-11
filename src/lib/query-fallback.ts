/** Keep transient transport failures out of TanStack Query caches.
 * A thrown refetch retains the last successful data. */
export function fallbackUnlessWsDisconnected<T>(
  error: unknown,
  fallback: T
): T {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('WebSocket disconnected')) throw error
  return fallback
}
