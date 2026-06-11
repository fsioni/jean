import { beforeEach, describe, expect, it, vi } from 'vitest'

const openUrlMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: openUrlMock,
}))

describe('openExternal', () => {
  beforeEach(() => {
    vi.resetModules()
    openUrlMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('opens native/mobile Tauri URLs with the OS default browser opener', async () => {
    openUrlMock.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: { invoke: vi.fn() },
      open: vi.fn(),
    })
    vi.stubGlobal('navigator', { platform: 'iPhone' })

    const { openExternal } = await import('./platform')

    await openExternal('https://github.com/owner/repo/issues/123')

    expect(openUrlMock).toHaveBeenCalledWith(
      'https://github.com/owner/repo/issues/123'
    )
    expect(openUrlMock).not.toHaveBeenCalledWith(
      'https://github.com/owner/repo/issues/123',
      'inAppBrowser'
    )
    expect(window.open).not.toHaveBeenCalled()
  })

  it('uses a pre-opened web window only outside native Tauri', async () => {
    const preOpenedWindow = { location: { href: '' } } as Window
    vi.stubGlobal('window', {
      open: vi.fn(),
    })
    vi.stubGlobal('navigator', { platform: 'MacIntel' })

    const { openExternal } = await import('./platform')

    await openExternal(
      'https://github.com/owner/repo/pull/456',
      preOpenedWindow
    )

    expect(preOpenedWindow.location.href).toBe(
      'https://github.com/owner/repo/pull/456'
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})
