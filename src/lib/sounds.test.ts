import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let nativeApp = false

vi.mock('./environment', () => ({
  isNativeApp: () => nativeApp,
}))

// --- Web Audio mocks ---------------------------------------------------------

const sourceStart = vi.fn()
const sourceStop = vi.fn()
const oscStart = vi.fn()
const oscStop = vi.fn()

// Captured instances so tests can inspect frequency/type of fallback tones.
const createdOscillators: MockOscillator[] = []

class MockBufferSource {
  buffer: unknown = null
  onended: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  start = sourceStart
  stop = sourceStop
}

class MockOscillator {
  frequency = { value: 0 }
  type = ''
  connect = vi.fn()
  start = oscStart
  stop = oscStop
}

class MockGain {
  gain = { value: 0 }
  connect = vi.fn()
}

const decodeAudioData = vi.fn()
const audioContextConstructor = vi.fn()

class MockAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  resume = vi.fn(() => Promise.resolve())
  createBufferSource = vi.fn(() => new MockBufferSource())
  createOscillator = vi.fn(() => {
    const osc = new MockOscillator()
    createdOscillators.push(osc)
    return osc
  })
  createGain = vi.fn(() => new MockGain())
  decodeAudioData = decodeAudioData

  constructor() {
    audioContextConstructor()
  }
}

const fetchMock = vi.fn()

describe('notification sounds', () => {
  beforeEach(() => {
    nativeApp = false
    createdOscillators.length = 0
    vi.clearAllMocks()
    vi.resetModules()

    decodeAudioData.mockResolvedValue({ duration: 1 })
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })

    vi.stubGlobal('AudioContext', MockAudioContext)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch or play audio when web access sounds are disabled', async () => {
    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork', { webAccessSoundsEnabled: false })
    await Promise.resolve()

    expect(audioContextConstructor).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sourceStart).not.toHaveBeenCalled()
  })

  it('still plays sounds in the native app when the web access flag is disabled', async () => {
    nativeApp = true
    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork', { webAccessSoundsEnabled: false })

    await vi.waitFor(() => expect(sourceStart).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/sounds/work-work.wav')
  })

  it('plays a distinct fallback tone per sound when decoding fails', async () => {
    nativeApp = true
    decodeAudioData.mockRejectedValue(new Error('no codec'))
    const { playNotificationSound } = await import('./sounds')

    playNotificationSound('workwork')
    await vi.waitFor(() => expect(oscStart).toHaveBeenCalledTimes(1))
    playNotificationSound('jobsdone')
    await vi.waitFor(() => expect(oscStart).toHaveBeenCalledTimes(2))

    expect(createdOscillators).toHaveLength(2)
    const [workworkOsc, jobsdoneOsc] = createdOscillators
    expect(workworkOsc?.frequency.value).not.toBe(jobsdoneOsc?.frequency.value)
  })

  it('skips preloading in web access when sounds are disabled', async () => {
    const { preloadAllSounds } = await import('./sounds')

    preloadAllSounds({ webAccessSoundsEnabled: false })
    await Promise.resolve()

    expect(audioContextConstructor).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preloads and decodes every sound asset in the native app', async () => {
    nativeApp = true
    const { preloadAllSounds } = await import('./sounds')

    preloadAllSounds()

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenCalledWith('/sounds/work-work.wav')
    expect(fetchMock).toHaveBeenCalledWith('/sounds/jobs-done.wav')
  })
})
