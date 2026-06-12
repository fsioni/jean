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
      e.preventDefault()
      e.stopPropagation()
      onClose(e)
    },
  }
}
