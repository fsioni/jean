import { useEffect, useRef } from 'react'

export const DEFAULT_VISIBLE_TICK_MS = 1000
export const DEFAULT_HIDDEN_TICK_MS = 30_000

export function useVisibilityAwareTicker(
  enabled: boolean,
  onTick: () => void,
  visibleTickMs = DEFAULT_VISIBLE_TICK_MS,
  hiddenTickMs = DEFAULT_HIDDEN_TICK_MS
) {
  const onTickRef = useRef(onTick)

  useEffect(() => {
    onTickRef.current = onTick
  }, [onTick])

  useEffect(() => {
    if (!enabled) return
    if (typeof document === 'undefined') {
      onTickRef.current()
      return
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const delay = () =>
      document.visibilityState === 'hidden' ? hiddenTickMs : visibleTickMs

    const clear = () => {
      if (timeoutId == null) return
      clearTimeout(timeoutId)
      timeoutId = null
    }

    const tick = () => {
      onTickRef.current()
      schedule()
    }

    const schedule = () => {
      clear()
      timeoutId = setTimeout(tick, delay())
    }

    const handleVisibilityChange = () => {
      onTickRef.current()
      schedule()
    }

    onTickRef.current()
    schedule()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clear()
    }
  }, [enabled, hiddenTickMs, visibleTickMs])
}
