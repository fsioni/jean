import { useCallback, useEffect, useState } from 'react'
import { useVisibilityAwareTicker } from '@/hooks/useVisibilityAwareTicker'
import { formatDuration } from '../time-utils'

export function useElapsedTime(startTime: number | null): string | null {
  const [elapsed, setElapsed] = useState<number | null>(null)
  const updateElapsed = useCallback(() => {
    if (startTime == null) return
    setElapsed(Date.now() - startTime)
  }, [startTime])

  useEffect(() => {
    if (startTime == null) {
      setElapsed(null)
    } else {
      setElapsed(Date.now() - startTime)
    }
  }, [startTime])

  useVisibilityAwareTicker(startTime != null, updateElapsed)

  if (elapsed == null) return null
  return formatDuration(elapsed)
}
