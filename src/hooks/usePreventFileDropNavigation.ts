import { useEffect } from 'react'

/**
 * Global safety net for file drops.
 *
 * Tauri runs with `dragDropEnabled: false` (so the browser DataTransfer API
 * works for chat image drops). The trade-off: Tauri no longer stops the webview
 * from navigating to a dropped file. Any view WITHOUT its own drop handler
 * (terminal, settings, dashboard, onboarding…) would otherwise let a stray
 * image drop open it fullscreen as `file://`, locking the whole window.
 *
 * This catch-all calls `preventDefault()` on `dragover`/`drop` for file drags
 * so the webview can never navigate. It NEVER calls `stopPropagation`, so
 * view-specific handlers (chat image drop, terminal drop) still receive and
 * process the event normally.
 */
export function usePreventFileDropNavigation(): void {
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const handleDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const handleDrop = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }

    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])
}
