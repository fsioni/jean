import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { browserBackend } from '@/hooks/useBrowserPane'
import {
  buildRemoteWebAccessUrl,
  type RemoteConnection,
} from '@/lib/remote-connections'
import { isClientLinux, isClientMacOS } from '@/lib/platform'
import { LinuxWindowControls } from '@/components/titlebar/LinuxWindowControls'
import { WindowResizeHandles } from '@/components/layout/WindowResizeHandles'
import { RemoteConnectionsDialog } from './RemoteConnectionsDialog'

const REMOTE_WEBVIEW_ID = 'remote-jean-ui'

export function RemoteWebAccessShell({
  connection,
}: {
  connection: RemoteConnection
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const connectionDialogOpenRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    let cancelled = false
    let frame: number | null = null

    const measure = () => {
      const rect = contentRef.current?.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      return {
        x: Math.round((rect?.left ?? 0) * dpr),
        y: Math.round((rect?.top ?? 0) * dpr),
        width: Math.round(Math.max(rect?.width ?? 0, 1) * dpr),
        height: Math.round(Math.max(rect?.height ?? 0, 1) * dpr),
      }
    }

    const updateBounds = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        void browserBackend.setBounds(REMOTE_WEBVIEW_ID, measure())
      })
    }

    const observer = new ResizeObserver(updateBounds)
    if (contentRef.current) observer.observe(contentRef.current)
    window.addEventListener('resize', updateBounds)

    void (async () => {
      await browserBackend.close(REMOTE_WEBVIEW_ID)
      if (cancelled) return
      try {
        await browserBackend.create(
          REMOTE_WEBVIEW_ID,
          buildRemoteWebAccessUrl(connection),
          measure()
        )
        if (connectionDialogOpenRef.current) {
          await browserBackend.setVisible(REMOTE_WEBVIEW_ID, false)
        }
      } catch (createError) {
        if (!cancelled) setError(String(createError))
      }
    })()

    return () => {
      cancelled = true
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
      if (frame !== null) cancelAnimationFrame(frame)
      void browserBackend.close(REMOTE_WEBVIEW_ID)
    }
  }, [connection])

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background">
      {isClientLinux && <WindowResizeHandles />}
      <div
        data-tauri-drag-region
        className="relative z-[60] flex h-8 shrink-0 items-center justify-between bg-background/80 px-2"
      >
        <div
          className={isClientMacOS ? 'pl-[72px]' : undefined}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <RemoteConnectionsDialog
            onOpenChange={open => {
              connectionDialogOpenRef.current = open
              void browserBackend
                .setVisible(REMOTE_WEBVIEW_ID, !open)
                .catch(() => undefined)
            }}
          />
        </div>
        <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 truncate text-xs text-foreground/60">
          {connection.name}
        </span>
        <div style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          {isClientLinux && <LinuxWindowControls />}
        </div>
      </div>
      <div ref={contentRef} className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {error
            ? `Could not load ${connection.name}: ${error}`
            : 'Loading Jean…'}
        </div>
      </div>
    </div>
  )
}
