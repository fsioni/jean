import { useEffect, useRef } from 'react'
import { invoke } from '@/lib/transport'
import { isTauri } from '@/services/projects'
import { logger } from '@/lib/logger'

/** Don't poke more than once per this window (avoids focus-event storms). */
const MIN_POKE_INTERVAL_MS = 5000

/**
 * Forces an immediate Jenkins poll when the window regains focus / becomes
 * visible, so the CI pills don't wait out the adaptive poll interval after the
 * user tabs back in. Nudges the backend poller once (one batched refresh for all
 * worktrees) rather than fetching per row.
 *
 * Native app only — the poller and the `poke_jenkins_poll` command live in the
 * Tauri process.
 */
export function useJenkinsFocusRefresh() {
  const lastPokeRef = useRef(0)

  useEffect(() => {
    if (!isTauri()) return

    const poke = () => {
      const now = Date.now()
      if (now - lastPokeRef.current < MIN_POKE_INTERVAL_MS) return
      lastPokeRef.current = now
      invoke('poke_jenkins_poll').catch(error =>
        logger.debug('Jenkins poke failed', { error })
      )
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') poke()
    }

    window.addEventListener('focus', poke)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.removeEventListener('focus', poke)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])
}
