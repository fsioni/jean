/**
 * Transport abstraction layer.
 *
 * Drop-in replacements for @tauri-apps/api/core invoke() and
 * @tauri-apps/api/event listen(). Routes through Tauri IPC when
 * running as a native app, or WebSocket when running in a browser.
 */

import { useSyncExternalStore } from 'react'
import { isNativeApp, setWsConnected } from './environment'
import { generateId } from './uuid'

// ---------------------------------------------------------------------------
// File source URL conversion (drop-in for Tauri's convertFileSrc)
// ---------------------------------------------------------------------------

// Cache for the server's app data directory path (set from init data or hook).
// Used by convertFileSrc in browser mode to build /api/files/ URLs.
let _appDataDir: string | null = null

/** Set the app data directory path for browser-mode file URL conversion. */
export function setAppDataDir(dir: string): void {
  // Normalize: ensure trailing separator for reliable startsWith matching
  _appDataDir = dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}/`
}

/**
 * Convert a filesystem path to a URL loadable by the webview.
 * Re-implements Tauri's convertFileSrc() as pure string manipulation
 * to avoid a static import of @tauri-apps/api/core (which crashes in
 * browser mode because it checks for __TAURI_INTERNALS__ on load).
 *
 * In browser mode, converts to /api/files/ URLs served by the HTTP server.
 */
export function convertFileSrc(filePath: string, protocol = 'asset'): string {
  if (isNativeApp()) {
    // Use Tauri's native implementation which correctly percent-encodes paths
    // on all platforms (JS encodeURIComponent misses dots/hyphens/underscores
    // that Tauri's Rust encoder expects on Windows).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = (window as any).__TAURI_INTERNALS__
    if (internals?.convertFileSrc) {
      return internals.convertFileSrc(filePath, protocol)
    }
    // Fallback (should not reach in native app)
    const path = encodeURIComponent(filePath)
    return navigator.userAgent.includes('Windows')
      ? `https://${protocol}.localhost/${path}`
      : `${protocol}://localhost/${path}`
  }

  // Browser mode: convert server filesystem path to /api/files/ URL
  const token = localStorage.getItem('jean-http-token') || ''
  const params = token ? `?token=${encodeURIComponent(token)}` : ''

  // Try exact prefix match with cached app data dir
  if (_appDataDir && filePath.startsWith(_appDataDir)) {
    const relativePath = filePath.substring(_appDataDir.length)
    return `/api/files/${encodeURI(relativePath)}${params}`
  }

  // Fallback: detect app data dir marker in path (works before _appDataDir is set)
  for (const marker of ['com.jean.desktop/', 'com.jean.desktop\\']) {
    const idx = filePath.indexOf(marker)
    if (idx !== -1) {
      const relativePath = filePath.substring(idx + marker.length)
      return `/api/files/${encodeURI(relativePath)}${params}`
    }
  }

  // Last resort: return as-is (will likely not render, but won't crash)
  return filePath
}

/**
 * Convert an absolute project/worktree file path to a browser-loadable URL.
 * Native mode can use Tauri's asset protocol directly; browser mode uses the
 * authenticated project-file endpoint, which validates the path against known
 * project/worktree roots before serving it.
 */
export function convertProjectFileSrc(filePath: string): string {
  if (isNativeApp()) {
    return convertFileSrc(filePath)
  }

  const token = localStorage.getItem('jean-http-token') || ''
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  return `/api/project-files/${encodeURIComponent(filePath)}${params}`
}

/** Unlisten function type — compatible with Tauri's UnlistenFn. */
export type UnlistenFn = () => void

// ---------------------------------------------------------------------------
// Public API (same signatures as Tauri)
// ---------------------------------------------------------------------------

/**
 * Call a backend command. Drop-in replacement for Tauri's invoke().
 */
export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  // E2E mock transport — route to in-memory handlers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e2eMock = (window as any).__JEAN_E2E_MOCK__
  if (e2eMock) {
    const handler = e2eMock.invokeHandlers[command]
    if (handler) return handler(args) as T
    console.warn(`[E2E] No mock for command: ${command}`)
    return null as T
  }

  if (isNativeApp()) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
    return tauriInvoke<T>(command, args)
  }
  return wsTransport.invoke<T>(command, args)
}

/**
 * Listen for backend events. Drop-in replacement for Tauri's listen().
 * Returns an unlisten function.
 */
export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  // E2E mock transport — route to in-memory event emitter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e2eMock = (window as any).__JEAN_E2E_MOCK__
  if (e2eMock) {
    const et = e2eMock.eventEmitter as EventTarget
    const wrapped = (e: Event) =>
      handler({ payload: (e as CustomEvent).detail })
    et.addEventListener(event, wrapped)
    return () => et.removeEventListener(event, wrapped)
  }

  if (isNativeApp()) {
    const { listen: tauriListen } = await import('@tauri-apps/api/event')
    return tauriListen<T>(event, handler)
  }
  return wsTransport.listen<T>(event, handler)
}

/**
 * Request buffered terminal events from the backend. Used by browser-mode
 * terminal reattachment after a full page refresh, when in-memory sequence
 * tracking was lost but the Rust PTY and replay buffer are still alive.
 */
export function requestTerminalReplay(terminalId: string, lastSeq = 0): void {
  if (isNativeApp()) return
  wsTransport.requestTerminalReplay(terminalId, lastSeq)
}

// ---------------------------------------------------------------------------
// Initial data preloading (used in browser mode)
// ---------------------------------------------------------------------------

export interface InitialData {
  projects?: unknown[]
  // Tiered payload: worktrees/sessions are present only for the selected
  // project; other projects are lazy-loaded by TanStack Query hooks on
  // navigation.
  worktreesByProject?: Record<string, unknown[]>
  sessionsByWorktree?: Record<string, unknown> // worktreeId -> WorktreeSessions
  activeSessions?: Record<string, unknown> // sessionId -> Session (with messages)
  activeSessionWorktreeIds?: Record<string, string> // sessionId -> worktreeId
  runningSessions?: string[] // sessionIds with active CLI processes
  replayEvents?: BootstrapEvent[]
  preferences?: unknown
  uiState?: unknown
  appDataDir?: string
  webBuildId?: string
  appVersion?: string
}

let initialDataPromise: Promise<InitialData | null> | null = null
let initialDataResolved = false
let reconnectInitialDataPromise: Promise<InitialData | null> | null = null

/**
 * Build the /api/init URL with the given query params.
 * Centralizes token + selected_project + active_sessions encoding.
 */
function buildInitUrl(opts: {
  mode?: 'initial' | 'reconnect'
  selectedProjectId?: string | null
  activeSessionIds?: Record<string, string>
}): string {
  const urlToken = new URLSearchParams(window.location.search).get('token')
  const token = urlToken || localStorage.getItem('jean-http-token') || ''

  const params = new URLSearchParams()
  if (token) params.set('token', token)
  if (opts.mode === 'reconnect') params.set('mode', 'reconnect')
  if (opts.selectedProjectId) {
    params.set('selected_project', opts.selectedProjectId)
  }
  if (opts.activeSessionIds && Object.keys(opts.activeSessionIds).length > 0) {
    const pairs = Object.entries(opts.activeSessionIds)
      .map(([wId, sId]) => `${wId}:${sId}`)
      .join(',')
    params.set('active_sessions', pairs)
  }
  const qs = params.toString()
  return qs ? `/api/init?${qs}` : '/api/init'
}

/**
 * Preload initial data via HTTP before WebSocket connects.
 * This allows the web view to show content immediately instead of
 * waiting for WebSocket connection + command round-trip.
 *
 * Returns null if preloading fails (app will fall back to WebSocket).
 *
 * @param selectedProjectId - Browser's currently-selected project id.
 *   Sent so the server scopes the init payload to just that project's
 *   worktrees/sessions. Falls back to `ui_state.json` on disk when absent.
 */
export async function preloadInitialData(
  selectedProjectId?: string | null
): Promise<InitialData | null> {
  if (isNativeApp()) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== 'undefined' && (window as any).__JEAN_E2E_MOCK__)
    return null
  if (initialDataPromise) return initialDataPromise

  initialDataPromise = (async () => {
    try {
      const url = buildInitUrl({ selectedProjectId })
      const response = await fetch(url)
      if (!response.ok) {
        return null
      }
      const data = await response.json()
      initialDataResolved = true
      return data as InitialData
    } catch {
      return null
    }
  })()

  return initialDataPromise
}

/**
 * Re-fetch initial data via HTTP (bypasses memoization).
 * Used on WebSocket reconnect to bulk-reload fresh state.
 *
 * @param activeSessionIds - Browser's current active session IDs per worktree.
 *   Sent to the server so it loads the correct sessions even when ui_state.json
 *   is stale (debounced save hasn't flushed yet).
 * @param selectedProjectId - Browser's currently-selected project id. Scopes
 *   the payload to that project; falls back to `ui_state.json` when absent.
 */
export async function refetchInitialData(
  activeSessionIds?: Record<string, string>,
  selectedProjectId?: string | null
): Promise<InitialData | null> {
  if (isNativeApp()) return null

  try {
    const url = buildInitUrl({
      mode: 'reconnect',
      selectedProjectId,
      activeSessionIds,
    })
    const response = await fetch(url)
    if (!response.ok) return null
    return (await response.json()) as InitialData
  } catch {
    return null
  }
}

/**
 * Start loading reconnect bootstrap data while the WebSocket is still
 * reconnecting, so the UI can re-seed immediately once the socket is open.
 */
export function prefetchReconnectInitialData(
  activeSessionIds?: Record<string, string>,
  selectedProjectId?: string | null
): Promise<InitialData | null> {
  if (!reconnectInitialDataPromise) {
    reconnectInitialDataPromise = refetchInitialData(
      activeSessionIds,
      selectedProjectId
    )
  }
  return reconnectInitialDataPromise
}

/**
 * Use the in-flight reconnect bootstrap fetch if one exists; otherwise fetch
 * now. The consumed promise is cleared so a future reconnect gets fresh data.
 */
export async function consumeReconnectInitialData(
  activeSessionIds?: Record<string, string>,
  selectedProjectId?: string | null
): Promise<InitialData | null> {
  const prefetched = reconnectInitialDataPromise
  const promise =
    prefetched ?? refetchInitialData(activeSessionIds, selectedProjectId)
  reconnectInitialDataPromise = null
  const data = await promise
  if (!data && prefetched) {
    return refetchInitialData(activeSessionIds, selectedProjectId)
  }
  return data
}

/**
 * Check if initial data has been preloaded.
 */
export function hasPreloadedData(): boolean {
  return initialDataResolved
}

/**
 * Get the preloaded initial data if available (non-blocking).
 */
export function getPreloadedData(): InitialData | null {
  if (!initialDataResolved || !initialDataPromise) return null
  // Since initialDataResolved is true, the promise has resolved
  let result: InitialData | null = null
  initialDataPromise.then(data => {
    result = data
  })
  return result
}

// ---------------------------------------------------------------------------
// WebSocket Transport (used in browser mode)
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface WsMessage {
  type: 'response' | 'error' | 'event' | 'heartbeat'
  id?: string
  data?: unknown
  error?: string
  event?: string
  payload?: unknown
  /** Monotonic sequence number for event replay on reconnect. */
  seq?: number
}

export interface BootstrapEvent {
  type: 'event'
  event: string
  payload: unknown
  seq?: number
}

class WsTransport {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectWatchdog: ReturnType<typeof setTimeout> | null = null
  /** Periodic check that we're seeing inbound traffic from the server.
   *  The server sends app-level heartbeats every 20s because browser JS cannot
   *  observe protocol ping/pong frames, so a 50s gap means the connection is dead. */
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private _lastInbound = 0
  private queue: { data: string; resolve: () => void }[] = []
  // Buffer for events that arrive before listeners are registered.
  // Covers the ~16ms gap between WS onopen and React effect listener setup.
  private eventBuffer = new Map<
    string,
    { msg: WsMessage; bufferedAt: number }[]
  >()
  private static readonly EVENT_BUFFER_MAX_AGE = 5_000
  private static readonly EVENT_BUFFER_MAX_SIZE = 50
  private _connected = false
  private _connecting = false
  private _authError: string | null = null
  private _dataReady = false
  private _tokenValidated = false
  private _lastConnectTime = 0
  private _subscribers = new Set<() => void>()
  private _connectEnabled = false
  /** Track last seen seq per session for replay on reconnect. */
  private _lastSeqBySession = new Map<string, number>()
  /** Sessions that were actively streaming when we disconnected. */
  private _activeStreamingSessions = new Set<string>()
  /** Track last seen seq per terminal for replay on reconnect. */
  private _lastSeqByTerminal = new Map<string, number>()
  /** Terminals that were running when we (potentially) disconnected. */
  private _activeTerminals = new Set<string>()

  constructor() {
    // Reconnect instantly when the page returns to the foreground or the
    // network comes back. Mobile browsers suspend background tabs and freeze
    // JS timers, so the livenessTimer cannot detect a dead socket until it
    // resumes — these listeners give us an immediate wake trigger.
    if (typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleWake)
      window.addEventListener('online', this.handleWake)
      window.addEventListener('pageshow', this.handleWake)
    }
  }

  get connected(): boolean {
    return this._connected
  }

  get authError(): string | null {
    return this._authError
  }

  get dataReady(): boolean {
    return this._dataReady
  }

  private setConnected(value: boolean): void {
    this._connected = value
    setWsConnected(value)
    if (!value) {
      // Mark data as not ready when disconnected — overlay should stay
      // visible until seedCache() completes after reconnect.
      this._dataReady = false
    }
    this.notifySubscribers()
  }

  setDataReady(value: boolean): void {
    if (this._dataReady === value) return
    this._dataReady = value
    this.notifySubscribers()
  }

  private setAuthError(error: string | null): void {
    this._authError = error
    this.notifySubscribers()
  }

  private notifySubscribers(): void {
    for (const cb of this._subscribers) cb()
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(callback: () => void): () => void {
    this._subscribers.add(callback)
    return () => this._subscribers.delete(callback)
  }

  /** Get current connection snapshot for useSyncExternalStore. */
  getSnapshot(): boolean {
    return this._connected
  }

  /** Get current data-ready snapshot for useSyncExternalStore. */
  getDataReadySnapshot(): boolean {
    return this._dataReady
  }

  /** Get current auth error snapshot for useSyncExternalStore. */
  getAuthErrorSnapshot(): string | null {
    return this._authError
  }

  /** Connect to the WebSocket server (validates token first). */
  connect(): void {
    if (!this._connectEnabled) return
    if (
      this._connecting ||
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    )
      return

    // Read token from URL query param or localStorage
    const urlToken = new URLSearchParams(window.location.search).get('token')
    const token = urlToken || localStorage.getItem('jean-http-token') || ''

    // Persist token from URL to localStorage for future page loads
    if (urlToken) {
      localStorage.setItem('jean-http-token', urlToken)

      // Remove token from URL for security (prevent history/bookmark exposure)
      const url = new URL(window.location.href)
      url.searchParams.delete('token')
      window.history.replaceState({}, '', url.toString())
    }

    this._connecting = true

    // On reconnect with a previously-validated token, skip auth HTTP
    // round-trip and go straight to WebSocket. If the token has been
    // revoked, the WS handshake will fail and onclose will fire —
    // we detect that (rapid close within 2s) and fall back to full
    // validation on the next attempt.
    if (this._tokenValidated && token) {
      this.connectWs(token)
      this._connecting = false
    } else {
      this.validateAndConnect(token).finally(() => {
        this._connecting = false
      })
    }
  }

  enableConnect(): void {
    if (this._connectEnabled) return
    this._connectEnabled = true
    this.connect()
  }

  private async validateAndConnect(token: string): Promise<void> {
    const authUrl = token
      ? `${window.location.origin}/api/auth?token=${encodeURIComponent(token)}`
      : `${window.location.origin}/api/auth`

    try {
      const res = await fetch(authUrl)
      if (!res.ok) {
        // Invalid token — clear it, set error, don't reconnect
        localStorage.removeItem('jean-http-token')
        this._tokenValidated = false
        this.setAuthError(
          token
            ? "Invalid access token. Check the URL in Jean's Web Access settings."
            : "No access token provided. Use the URL from Jean's Web Access settings."
        )
        return
      }
    } catch {
      // Server unreachable — schedule reconnect (not an auth error)
      this.setAuthError(null)
      this.scheduleReconnect()
      return
    }

    // Token valid (or not required) — clear any previous auth error and connect
    this.setAuthError(null)
    this._tokenValidated = true
    this.connectWs(token)
  }

  private connectWs(token: string): void {
    // Derive WS URL from current page location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const url = `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`

    this.ws = new WebSocket(url)
    this.clearConnectWatchdog()
    this.connectWatchdog = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.CONNECTING) {
        console.warn(
          '[WsTransport] WebSocket connect watchdog fired, forcing reconnect'
        )
        try {
          this.ws.close()
        } catch {
          // Ignore close errors; reconnect logic handles recovery.
        }
      }
    }, WsTransport.CONNECT_TIMEOUT)

    this.ws.onopen = () => {
      this.clearConnectWatchdog()
      this._lastConnectTime = Date.now()
      this._lastInbound = Date.now()
      this.startLivenessTimer()
      this.setConnected(true)
      this.reconnectAttempt = 0

      // Replay missed events for sessions that were actively streaming
      for (const sessionId of this._activeStreamingSessions) {
        const lastSeq = this._lastSeqBySession.get(sessionId)
        if (lastSeq != null) {
          this.ws?.send(
            JSON.stringify({
              type: 'replay',
              session_id: sessionId,
              last_seq: lastSeq,
            })
          )
        }
      }

      // Replay missed terminal output (heals output gap during disconnect)
      for (const terminalId of this._activeTerminals) {
        const lastSeq = this._lastSeqByTerminal.get(terminalId)
        if (lastSeq != null) {
          this.ws?.send(
            JSON.stringify({
              type: 'terminal_replay',
              terminal_id: terminalId,
              last_seq: lastSeq,
            })
          )
        }
      }

      // Flush queued messages
      for (const item of this.queue) {
        this.ws?.send(item.data)
        item.resolve()
      }
      this.queue = []
    }

    this.ws.onmessage = event => {
      this._lastInbound = Date.now()
      try {
        const msg: WsMessage = JSON.parse(event.data)
        this.handleMessage(msg)
      } catch {
        // Ignore malformed messages
      }
    }

    this.ws.onclose = () => {
      this.clearConnectWatchdog()
      this.stopLivenessTimer()
      this.ws = null

      // If the socket closed within 2s of opening, the token may have been
      // revoked — force full auth validation on the next attempt.
      if (this._lastConnectTime && Date.now() - this._lastConnectTime < 2000) {
        this._tokenValidated = false
      }

      this.setConnected(false)

      // Clear event buffer — stale events from a dead connection
      // must not be delivered when the next connection opens.
      this.eventBuffer.clear()

      // Reject all pending command promises immediately — the server
      // response will never arrive on this socket. Prevents waiting
      // the full timeout (up to 10 min for long-running commands).
      for (const [, pending] of this.pending.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('WebSocket disconnected'))
      }
      this.pending.clear()

      // Clear queued-but-unsent messages to prevent reconnect from
      // flushing stale commands that spawn duplicate CLI processes.
      this.queue = []

      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  // Commands that spawn/attach to long-lived processes or are critical to
  // terminal lifecycle. These get an extended timeout instead of the default
  // 60s so idle/reconnect edges do not falsely fail terminal sessions.
  private static readonly LONG_RUNNING_COMMANDS: ReadonlySet<string> = new Set([
    'send_chat_message',
    'run_review_with_ai',
    'create_pr_with_ai_content',
    'create_commit_with_ai',
    'execute_summarization',
    'install_claude_cli',
    'install_codex_cli',
    'install_opencode_cli',
    'install_pi_cli',
    'install_gh_cli',
    'install_coderabbit_cli',
    'update_coderabbit_cli',
    'run_coderabbit_review',
    'trigger_coderabbit_pr_review',
    'start_terminal',
    'terminal_write',
    'terminal_resize',
    'stop_terminal',
    'get_active_terminals',
    'has_active_terminal',
    'get_terminal_listening_ports',
  ])
  private static readonly LONG_TIMEOUT = 30 * 60_000
  private static readonly DEFAULT_TIMEOUT = 60_000
  private static readonly CONNECT_TIMEOUT = 12_000
  private static readonly MAX_QUEUE_SIZE = 500
  /** If no inbound traffic for this long, assume connection is dead.
   *  Must exceed the server's app-level heartbeat interval (20s); protocol
   *  ping/pong alone is not visible to browser JavaScript. */
  private static readonly INBOUND_TIMEOUT = 50_000
  private static readonly LIVENESS_CHECK_INTERVAL = 10_000
  /** After a resume, wait this long for queued inbound frames to flush before
   *  judging an OPEN socket stale (avoids false reconnects on a healthy socket). */
  private static readonly WAKE_RECHECK_DELAY = 3_000

  /** Call a backend command over WebSocket. */
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const id = generateId()
    const data = JSON.stringify({
      type: 'invoke',
      id,
      command,
      args: args || {},
    })

    const timeoutMs = WsTransport.LONG_RUNNING_COMMANDS.has(command)
      ? WsTransport.LONG_TIMEOUT
      : WsTransport.DEFAULT_TIMEOUT

    return new Promise<T>((resolve, reject) => {
      if (this._authError) {
        reject(new Error(this._authError))
        return
      }

      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(`Command '${command}' timed out after ${timeoutMs / 1000}s`)
        )
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeout,
      })

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(data)
      } else {
        if (this.queue.length >= WsTransport.MAX_QUEUE_SIZE) {
          clearTimeout(timeout)
          this.pending.delete(id)
          reject(
            new Error(
              `Command queue is full (${WsTransport.MAX_QUEUE_SIZE}). Reconnecting WebSocket...`
            )
          )
          this.forceReconnect()
          return
        }

        // Queue for when connection is established
        this.queue.push({
          data,
          resolve() {
            /* noop */
          },
        })
        this.connect()
      }
    })
  }

  /** Request terminal replay and keep this terminal tracked for reconnects. */
  requestTerminalReplay(terminalId: string, lastSeq = 0): void {
    this._activeTerminals.add(terminalId)
    const currentLastSeq = this._lastSeqByTerminal.get(terminalId)
    const effectiveLastSeq =
      currentLastSeq == null ? lastSeq : Math.max(lastSeq, currentLastSeq)
    this._lastSeqByTerminal.set(terminalId, effectiveLastSeq)

    const payload = JSON.stringify({
      type: 'terminal_replay',
      terminal_id: terminalId,
      last_seq: effectiveLastSeq,
    })

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload)
      return
    }

    if (this._connectEnabled) {
      this.connect()
    }
  }

  /** Register an event listener. Returns an unlisten function. */
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    const typedHandler = handler as (event: { payload: unknown }) => void
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.listeners.get(event)!.add(typedHandler)

    // Drain buffered events that arrived before this listener was registered
    // (covers the gap between WS onopen and React effect listener setup)
    const buffered = this.eventBuffer.get(event)
    if (buffered && buffered.length > 0) {
      this.eventBuffer.delete(event)
      const now = Date.now()
      for (const { msg, bufferedAt } of buffered) {
        if (now - bufferedAt > WsTransport.EVENT_BUFFER_MAX_AGE) continue
        try {
          typedHandler({ payload: msg.payload })
        } catch (e) {
          console.error(`[WsTransport] Error draining buffered '${event}':`, e)
        }
      }
    }

    // Ensure connected once bootstrap explicitly enables it
    if (this._connectEnabled) {
      this.connect()
    }

    return () => {
      this.listeners.get(event)?.delete(typedHandler)
      if (this.listeners.get(event)?.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  private handleMessage(msg: WsMessage): void {
    if (msg.type === 'heartbeat') {
      // onmessage already refreshed _lastInbound. No listener dispatch.
      return
    }

    if (msg.type === 'response' && msg.id) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pending.delete(msg.id)
        pending.resolve(msg.data)
      }
    } else if (msg.type === 'error' && msg.id) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pending.delete(msg.id)
        pending.reject(new Error(msg.error || 'Unknown error'))
      }
    } else if (msg.type === 'event' && msg.event) {
      // Track seq per session for replay dedup + reconnect
      if (msg.seq != null && msg.payload) {
        const payload = msg.payload as Record<string, unknown>
        const sessionId = payload.session_id as string | undefined
        if (sessionId) {
          const lastSeen = this._lastSeqBySession.get(sessionId)
          if (lastSeen != null && msg.seq <= lastSeen) {
            return // Already processed — skip duplicate from replay
          }
          this._lastSeqBySession.set(sessionId, msg.seq)
          // Track actively streaming sessions
          if (msg.event === 'chat:chunk' || msg.event === 'chat:thinking') {
            this._activeStreamingSessions.add(sessionId)
          } else if (
            msg.event === 'chat:done' ||
            msg.event === 'chat:cancelled'
          ) {
            this._activeStreamingSessions.delete(sessionId)
            this._lastSeqBySession.delete(sessionId)
          }
        }

        // Track terminal seq for replay on reconnect (output gap healing)
        const terminalId = payload.terminal_id as string | undefined
        if (terminalId && msg.event.startsWith('terminal:')) {
          const lastSeen = this._lastSeqByTerminal.get(terminalId)
          if (lastSeen != null && msg.seq <= lastSeen) {
            return // Duplicate from replay — skip
          }
          this._lastSeqByTerminal.set(terminalId, msg.seq)
          if (msg.event === 'terminal:started') {
            this._activeTerminals.add(terminalId)
          } else if (msg.event === 'terminal:stopped') {
            this._activeTerminals.delete(terminalId)
            this._lastSeqByTerminal.delete(terminalId)
          }
        }
      }

      const handlers = this.listeners.get(msg.event)
      if (handlers && handlers.size > 0) {
        for (const handler of handlers) {
          try {
            handler({ payload: msg.payload })
          } catch (e) {
            console.error(`[WsTransport] Error in '${msg.event}' handler:`, e)
          }
        }
      } else {
        // Buffer events that arrive before listeners are registered
        // (happens during the React render cycle gap after WS connects)
        const buffered = this.eventBuffer.get(msg.event) ?? []
        if (buffered.length < WsTransport.EVENT_BUFFER_MAX_SIZE) {
          buffered.push({ msg, bufferedAt: Date.now() })
          this.eventBuffer.set(msg.event, buffered)
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    // Don't reconnect if there's an auth error — user needs to fix the token
    if (this._authError) return

    // Exponential backoff: 100ms, 500ms, 1s, 2s, 4s, ... max 30s
    // First attempt is fast (100ms) for brief disconnections.
    const delay =
      this.reconnectAttempt === 0
        ? 100
        : Math.min(500 * 2 ** (this.reconnectAttempt - 1), 30_000)
    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearConnectWatchdog(): void {
    if (!this.connectWatchdog) return
    clearTimeout(this.connectWatchdog)
    this.connectWatchdog = null
  }

  private startLivenessTimer(): void {
    this.stopLivenessTimer()
    this.livenessTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this._lastInbound > WsTransport.INBOUND_TIMEOUT) {
        console.warn(
          '[WsTransport] No inbound traffic, forcing reconnect (proxy/NAT idle drop?)'
        )
        try {
          this.ws.close()
        } catch {
          // Ignore close errors; onclose will schedule reconnect.
        }
      }
    }, WsTransport.LIVENESS_CHECK_INTERVAL)
  }

  private stopLivenessTimer(): void {
    if (!this.livenessTimer) return
    clearInterval(this.livenessTimer)
    this.livenessTimer = null
  }

  /** Re-check the connection when the page returns to the foreground or the
   *  network comes back. Fires on visibilitychange / online / pageshow. */
  private handleWake = (): void => {
    if (!this._connectEnabled) return
    // visibilitychange also fires on hide — only act when the page is visible.
    if (typeof document !== 'undefined' && document.hidden) return

    const state = this.ws?.readyState
    if (state === WebSocket.CONNECTING) return // connectWatchdog covers this

    if (state === WebSocket.OPEN) {
      // Socket claims to be open. After a suspend it may be a zombie, but a
      // healthy socket also looks stale until queued heartbeats are delivered.
      // Re-check shortly, once any buffered inbound traffic has landed.
      setTimeout(() => {
        if (
          this.ws?.readyState === WebSocket.OPEN &&
          Date.now() - this._lastInbound > WsTransport.INBOUND_TIMEOUT
        ) {
          console.warn(
            '[WsTransport] Stale socket after resume, forcing reconnect'
          )
          try {
            this.ws.close()
          } catch {
            // Ignore close errors; onclose schedules the reconnect.
          }
        }
      }, WsTransport.WAKE_RECHECK_DELAY)
      return
    }

    // Disconnected — reconnect immediately instead of waiting out the backoff.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    this.connect()
  }

  private forceReconnect(): void {
    this.clearConnectWatchdog()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // Ignore close errors; reconnect scheduling will recover.
      }
      return
    }
    this.scheduleReconnect()
  }

  ingestBootstrapEvents(events: BootstrapEvent[]): void {
    const sorted = [...events].sort(
      (a, b) =>
        (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
    )
    for (const event of sorted) {
      this.handleMessage(event)
    }
  }
}

// Singleton instance
const wsTransport = new WsTransport()

// ---------------------------------------------------------------------------
// React hooks for connection status (browser mode only)
// ---------------------------------------------------------------------------

const subscribe = (cb: () => void) => wsTransport.subscribe(cb)
const getSnapshot = () => wsTransport.getSnapshot()
const getDataReadySnapshot = () => wsTransport.getDataReadySnapshot()
const getAuthErrorSnapshot = () => wsTransport.getAuthErrorSnapshot()

// E2E mock: always report connected, no auth errors
const isE2eMocked =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof window !== 'undefined' && !!(window as any).__JEAN_E2E_MOCK__
// eslint-disable-next-line @typescript-eslint/no-empty-function
const noopSubscribe = () => () => {}

/**
 * React hook that returns the current WebSocket connection status.
 * Only meaningful in browser mode (!isNativeApp()).
 */
export function useWsConnectionStatus(): boolean {
  return useSyncExternalStore(
    isE2eMocked ? noopSubscribe : subscribe,
    isE2eMocked ? () => true : getSnapshot
  )
}

/**
 * React hook that returns whether reconnect data has been fully seeded.
 * Stays false from disconnect until seedCache() completes.
 * Only meaningful in browser mode (!isNativeApp()).
 */
export function useWsDataReady(): boolean {
  return useSyncExternalStore(
    isE2eMocked ? noopSubscribe : subscribe,
    isE2eMocked ? () => true : getDataReadySnapshot
  )
}

/** Mark WebSocket data as ready (called by App.tsx after seedCache). */
export function setWsDataReady(value: boolean): void {
  wsTransport.setDataReady(value)
}

/** Start browser WebSocket transport after preload/bootstrap is complete. */
export function connectTransport(): void {
  if (isNativeApp() || isE2eMocked) return
  wsTransport.enableConnect()
}

/**
 * Imperative connection check for non-React paths (e.g. xterm onData handler).
 * Native Tauri / E2E mock: always true (no transport drop concept).
 * Web mode: reflects current WebSocket connected state.
 */
export function isTransportConnected(): boolean {
  if (isNativeApp() || isE2eMocked) return true
  return wsTransport.connected
}

/**
 * Subscribe to transport connection state changes. No-op on native / E2E.
 * Used by non-React modules (e.g. terminal-instances.ts banner).
 * Returns unsubscribe.
 */
export function subscribeTransportStatus(cb: () => void): () => void {
  if (isNativeApp() || isE2eMocked) return noopSubscribe()
  return wsTransport.subscribe(cb)
}

/** Feed replayed server events through the normal event pipeline before connect. */
export function ingestBootstrapEvents(events: BootstrapEvent[]): void {
  if (events.length === 0) return
  wsTransport.ingestBootstrapEvents(events)
}

/**
 * React hook that returns the current auth error message, or null if none.
 * Only meaningful in browser mode (!isNativeApp()).
 */
export function useWsAuthError(): string | null {
  return useSyncExternalStore(
    isE2eMocked ? noopSubscribe : subscribe,
    isE2eMocked ? () => null : getAuthErrorSnapshot
  )
}
