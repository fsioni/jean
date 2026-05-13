import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setWsConnectedMock = vi.fn()

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new Event('close'))
  })

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.(new Event('open'))
    })
  }

  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

async function flushAsync() {
  await Promise.resolve()
  await Promise.resolve()
}

function getWs(index: number): MockWebSocket {
  const ws = MockWebSocket.instances[index]
  if (!ws) throw new Error(`Expected websocket instance ${index}`)
  return ws
}

async function loadTransportModule() {
  vi.resetModules()
  vi.doMock('./environment', () => ({
    isNativeApp: () => false,
    setWsConnected: setWsConnectedMock,
  }))
  return import('./transport')
}

describe('transport bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockWebSocket.instances = []
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./environment')
  })

  it('does not open websocket until bootstrap explicitly connects it', async () => {
    const transport = await loadTransportModule()

    await transport.listen('chat:chunk', vi.fn())
    expect(MockWebSocket.instances).toHaveLength(0)

    transport.connectTransport()
    await flushAsync()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(setWsConnectedMock).toHaveBeenCalledWith(true)
  })

  it('buffers bootstrap replay events before listeners connect and replays them in seq order', async () => {
    const transport = await loadTransportModule()
    const handler = vi.fn()

    transport.ingestBootstrapEvents([
      {
        type: 'event',
        event: 'chat:chunk',
        payload: { session_id: 'session-1', content: 'second' },
        seq: 2,
      },
      {
        type: 'event',
        event: 'chat:chunk',
        payload: { session_id: 'session-1', content: 'first' },
        seq: 1,
      },
    ])

    await transport.listen('chat:chunk', handler)

    expect(handler.mock.calls).toEqual([
      [{ payload: { session_id: 'session-1', content: 'first' } }],
      [{ payload: { session_id: 'session-1', content: 'second' } }],
    ])
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('dedupes terminal replay events by terminal sequence number', async () => {
    const transport = await loadTransportModule()
    const handler = vi.fn()

    await transport.listen('terminal:output', handler)
    transport.connectTransport()
    await flushAsync()

    const ws = getWs(0)
    ws.receive({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 'term-1', data: 'first' },
      seq: 10,
    })
    ws.receive({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 'term-1', data: 'duplicate' },
      seq: 10,
    })
    ws.receive({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 'term-1', data: 'second' },
      seq: 11,
    })

    expect(handler.mock.calls).toEqual([
      [{ payload: { terminal_id: 'term-1', data: 'first' } }],
      [{ payload: { terminal_id: 'term-1', data: 'second' } }],
    ])
  })

  it('ignores app-level heartbeat messages without dispatching events', async () => {
    const transport = await loadTransportModule()
    const handler = vi.fn()

    await transport.listen('heartbeat', handler)
    transport.connectTransport()
    await flushAsync()

    getWs(0).receive({ type: 'heartbeat' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps idle websocket alive when app-level heartbeats arrive', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()

    const ws = getWs(0)
    vi.advanceTimersByTime(49_000)
    expect(ws.close).not.toHaveBeenCalled()

    ws.receive({ type: 'heartbeat' })
    vi.advanceTimersByTime(40_000)
    expect(ws.close).not.toHaveBeenCalled()

    vi.advanceTimersByTime(11_000)
    expect(ws.close).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('uses extended timeout for terminal lifecycle commands', async () => {
    vi.useFakeTimers()
    const transport = await loadTransportModule()

    let rejected = false
    const request = transport
      .invoke('terminal_write', { terminalId: 'term-1', data: 'echo hi\r' })
      .catch(() => {
        rejected = true
      })

    vi.advanceTimersByTime(60_001)
    await flushAsync()

    expect(rejected).toBe(false)

    vi.advanceTimersByTime(30 * 60_000)
    await request

    expect(rejected).toBe(true)

    vi.useRealTimers()
  })

  it('requests terminal_replay for active terminals after websocket reconnect', async () => {
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()

    const firstWs = getWs(0)
    firstWs.receive({
      type: 'event',
      event: 'terminal:started',
      payload: { terminal_id: 'term-1', cols: 120, rows: 40 },
      seq: 20,
    })
    firstWs.receive({
      type: 'event',
      event: 'terminal:output',
      payload: { terminal_id: 'term-1', data: 'running' },
      seq: 21,
    })

    firstWs.close()
    await new Promise(resolve => setTimeout(resolve, 150))
    await flushAsync()

    const secondWs = getWs(1)
    expect(secondWs).toBeDefined()
    expect(secondWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'terminal_replay',
        terminal_id: 'term-1',
        last_seq: 21,
      })
    )
  })

  it('does not request terminal_replay after terminal stopped event', async () => {
    const transport = await loadTransportModule()

    transport.connectTransport()
    await flushAsync()

    const firstWs = getWs(0)
    firstWs.receive({
      type: 'event',
      event: 'terminal:started',
      payload: { terminal_id: 'term-1', cols: 120, rows: 40 },
      seq: 20,
    })
    firstWs.receive({
      type: 'event',
      event: 'terminal:stopped',
      payload: { terminal_id: 'term-1', exit_code: 0, signal: null },
      seq: 21,
    })

    firstWs.close()
    await new Promise(resolve => setTimeout(resolve, 150))
    await flushAsync()

    const secondWs = getWs(1)
    expect(secondWs).toBeDefined()
    expect(secondWs.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        type: 'terminal_replay',
        terminal_id: 'term-1',
        last_seq: 21,
      })
    )
  })
})
