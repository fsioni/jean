import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasBackend, isNativeApp, setWsConnected } from './environment'

const clearInternals = () => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__
}

describe('environment detection', () => {
  afterEach(() => {
    clearInternals()
    setWsConnected(false)
  })

  it('does not treat partial Tauri internals as native', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    expect(isNativeApp()).toBe(false)
    expect(hasBackend()).toBe(false)
  })

  it('treats Tauri internals with invoke as native', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: vi.fn() },
    })

    expect(isNativeApp()).toBe(true)
    expect(hasBackend()).toBe(true)
  })

  it('treats WebSocket connection as browser backend', () => {
    setWsConnected(true)

    expect(isNativeApp()).toBe(false)
    expect(hasBackend()).toBe(true)
  })
})
