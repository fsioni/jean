import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useElapsedTime } from './useElapsedTime'

describe('useElapsedTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('updates immediately when the start time changes', () => {
    const initialProps: { startTime: number | null } = { startTime: 9_000 }
    const { result, rerender } = renderHook(
      ({ startTime }: { startTime: number | null }) =>
        useElapsedTime(startTime),
      { initialProps }
    )

    expect(result.current).toBe('1s')

    rerender({ startTime: 8_000 })

    expect(result.current).toBe('2s')

    rerender({ startTime: null })

    expect(result.current).toBeNull()
  })
})
