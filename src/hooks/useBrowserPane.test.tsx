import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBrowserTabActions } from './useBrowserPane'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({
  invoke: invokeMock,
  listen: vi.fn(),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => true,
}))

describe('useBrowserTabActions grab integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.className = ''
    invokeMock.mockResolvedValue(undefined)
  })

  it('invokes the native React Grab injection command for the active tab', async () => {
    document.documentElement.classList.add('dark')
    const { result } = renderHook(() => useBrowserTabActions('tab-1'))

    await result.current.enableGrab()

    expect(invokeMock).toHaveBeenCalledWith('browser_enable_grab', {
      tabId: 'tab-1',
      theme: 'dark',
    })
  })
})
