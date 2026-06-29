import type { MouseEvent } from 'react'

/**
 * Props to spread on a clickable element so a middle-click (mouse wheel)
 * triggers `onClose`.
 *
 * The `onMouseDown` handler suppresses the browser's middle-click autoscroll,
 * which is triggered on mousedown — before `auxclick` fires — and so matters in
 * web-access/browser mode. `onAuxClick` performs the close on the middle button
 * only, leaving right-click (button 2) and its context menu untouched.
 */
export function middleClickClose(onClose: (e: MouseEvent) => void) {
  return {
    onMouseDown: (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return
      // Ignore middle-clicks that bubble up from an interactive descendant
      // (e.g. the expand chevron or pull/push badges inside a worktree row) so
      // only a middle-click on the row/tab body itself triggers the close. The
      // `!== currentTarget` check keeps this working when the element the helper
      // is spread on is itself a <button> (the terminal tab), and the selector
      // intentionally omits `[role="button"]` so the terminal tab's X span still
      // closes on middle-click.
      const interactive = (e.target as HTMLElement).closest(
        'button, a, input, textarea, select'
      )
      if (interactive && interactive !== e.currentTarget) return
      e.preventDefault()
      e.stopPropagation()
      onClose(e)
    },
  }
}
