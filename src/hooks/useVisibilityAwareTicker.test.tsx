import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVisibilityAwareTicker } from './useVisibilityAwareTicker'

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useVisibilityAwareTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibilityState('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks frequently while visible and slowly while hidden', () => {
    const onTick = vi.fn()

    renderHook(() => useVisibilityAwareTicker(true, onTick, 1000, 30_000))

    expect(onTick).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(1000))
    expect(onTick).toHaveBeenCalledTimes(2)

    act(() => setVisibilityState('hidden'))
    expect(onTick).toHaveBeenCalledTimes(3)

    act(() => vi.advanceTimersByTime(1000))
    expect(onTick).toHaveBeenCalledTimes(3)

    act(() => vi.advanceTimersByTime(29_000))
    expect(onTick).toHaveBeenCalledTimes(4)

    act(() => setVisibilityState('visible'))
    expect(onTick).toHaveBeenCalledTimes(5)

    act(() => vi.advanceTimersByTime(1000))
    expect(onTick).toHaveBeenCalledTimes(6)
  })

  it('does not tick when disabled', () => {
    const onTick = vi.fn()

    renderHook(() => useVisibilityAwareTicker(false, onTick, 1000, 30_000))

    act(() => vi.advanceTimersByTime(60_000))

    expect(onTick).not.toHaveBeenCalled()
  })
})
