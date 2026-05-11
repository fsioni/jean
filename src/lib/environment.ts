/**
 * Environment detection utilities.
 *
 * - isNativeApp(): true only when running inside the Tauri desktop shell
 * - hasBackend(): true when a backend is available (Tauri IPC or HTTP/WS)
 *
 * Services should guard with hasBackend(), not isTauri().
 * UI should use isNativeApp() to hide native-only features (Finder, external editors, etc.).
 */

/** Running inside the native Tauri desktop app with usable IPC.
 * Some mobile/web shells can expose a partial `__TAURI_INTERNALS__` object
 * without `invoke`; those must use the WebSocket transport instead. */
export const isNativeApp = (): boolean =>
  typeof window !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof (window as any).__TAURI_INTERNALS__?.invoke === 'function'

/** A backend is available (either Tauri IPC, WebSocket connection, or E2E mock). */
export const hasBackend = (): boolean => {
  if (isNativeApp()) return true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).__JEAN_E2E_MOCK__)
    return true
  // In browser mode, check if we have WS connection info
  // (set when the transport connects)
  return _wsConnected
}

// Internal flag set by WsTransport when connected
let _wsConnected = false
export const setWsConnected = (connected: boolean): void => {
  _wsConnected = connected
}
