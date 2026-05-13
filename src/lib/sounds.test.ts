import { beforeEach, describe, expect, it, vi } from 'vitest'

let nativeApp = false

vi.mock('./environment', () => ({
  isNativeApp: () => nativeApp,
}))

const playMock = vi.fn(() => Promise.resolve())
const pauseMock = vi.fn()
const audioConstructorMock = vi.fn()

class MockAudio {
  currentTime = 0
  preload = ''

  constructor(src?: string) {
    audioConstructorMock(src)
  }

  play = playMock
  pause = pauseMock
}

describe('notification sounds', () => {
  beforeEach(() => {
    nativeApp = false
    vi.clearAllMocks()
    vi.stubGlobal('Audio', MockAudio)
  })

  it('does not create or play audio when web access sounds are disabled', async () => {
    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork', { webAccessSoundsEnabled: false })

    expect(audioConstructorMock).not.toHaveBeenCalled()
    expect(playMock).not.toHaveBeenCalled()
  })

  it('still plays sounds in the native app when the web access flag is disabled', async () => {
    nativeApp = true
    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork', { webAccessSoundsEnabled: false })

    expect(audioConstructorMock).toHaveBeenCalledWith('/sounds/work-work.mp3')
    expect(playMock).toHaveBeenCalled()
  })

  it('skips preloading in web access when sounds are disabled', async () => {
    const { preloadAllSounds } = await import('./sounds')

    preloadAllSounds({ webAccessSoundsEnabled: false })

    expect(audioConstructorMock).not.toHaveBeenCalled()
  })
})
