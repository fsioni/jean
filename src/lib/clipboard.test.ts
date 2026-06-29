import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()

vi.mock('./environment', () => ({
  isNativeApp: () => false,
}))

vi.mock('./transport', () => ({
  invoke: invokeMock,
}))

const { copyToClipboard } = await import('./clipboard')

describe('copyToClipboard', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(null)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    document.execCommand = vi.fn().mockReturnValue(false)
  })

  it('falls back to backend clipboard when browser clipboard is unavailable', async () => {
    await copyToClipboard('debug details')

    expect(invokeMock).toHaveBeenCalledWith('write_clipboard_text', {
      text: 'debug details',
    })
  })

  it('falls back to backend clipboard when browser clipboard write is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new DOMException('denied')),
      },
    })

    await copyToClipboard('debug details')

    expect(invokeMock).toHaveBeenCalledWith('write_clipboard_text', {
      text: 'debug details',
    })
  })
})
