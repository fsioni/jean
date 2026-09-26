import { useCallback, useState, type ReactElement } from 'react'
import { Copy, Download } from '@/components/icons/reicon'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { copyToClipboard } from '@/lib/clipboard'
import { downloadLocalFile, resolveWorktreeFilePath } from '@/lib/local-file'

/** Read the current window selection as trimmed plain text. */
export function getTrimmedSelectionText(): string {
  if (typeof window === 'undefined') return ''
  return window.getSelection()?.toString().trim() ?? ''
}

/**
 * Suppress the browser/OS default context menu on empty chat-thread chrome
 * (padding, gaps between messages) while leaving message-level custom menus
 * free to handle their own right-clicks.
 */
export function suppressDefaultContextMenu(
  event: React.MouseEvent | MouseEvent
): void {
  event.preventDefault()
}

interface MessageThreadContextMenuProps {
  children: ReactElement
  /**
   * Full message/response text for the "Copy message" / "Copy response" action.
   * Ignored when `onCopyMessage` is provided.
   */
  messageText?: string
  /** Label for the full-message copy action. */
  copyMessageLabel?: string
  /**
   * Custom full-message copy handler (e.g. rich user-prompt clipboard with
   * attachment metadata). Falls back to copying `messageText`.
   */
  onCopyMessage?: () => void | Promise<void>
}

/**
 * Custom right-click menu for session-thread messages.
 * Replaces the unusable browser default (Back / Refresh / Save as / Print)
 * with copy-focused actions.
 */
export function MessageThreadContextMenu({
  children,
  messageText = '',
  copyMessageLabel = 'Copy message',
  onCopyMessage,
}: MessageThreadContextMenuProps) {
  const [selection, setSelection] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [filePath, setFilePath] = useState('')

  // Runs on contextmenu (right-click, Android long press) and on pointerdown,
  // because Radix opens touch long presses from a pointerdown timer and iOS
  // Safari never fires contextmenu.
  const captureMenuTarget = useCallback((event: React.SyntheticEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const link = target?.closest('a[href]')
    setLinkUrl(link instanceof HTMLAnchorElement ? link.href : '')
    const fileCode = target?.closest<HTMLElement>('code[data-file-path]')
    setFilePath(fileCode?.dataset.filePath ?? '')
  }, [])

  const handleOpenChange = useCallback((open: boolean) => {
    // Capture selection when the menu opens — opening the menu can clear
    // the live Selection before the user picks an item.
    if (open) {
      setSelection(getTrimmedSelectionText())
    }
  }, [])

  const handleCopySelection = useCallback(() => {
    if (!selection) return
    void copyToClipboard(selection)
      .then(() => toast.success('Copied to clipboard'))
      .catch(() => toast.error('Failed to copy'))
  }, [selection])

  const handleCopyUrl = useCallback(() => {
    if (!linkUrl) return
    void copyToClipboard(linkUrl)
      .then(() => toast.success('Copied to clipboard'))
      .catch(() => toast.error('Failed to copy'))
  }, [linkUrl])

  const handleDownloadFile = useCallback(() => {
    const path = resolveWorktreeFilePath(filePath)
    if (!path) {
      toast.error('Cannot resolve file path')
      return
    }
    void downloadLocalFile(path).catch(error => {
      toast.error(`Failed to download file: ${error}`)
    })
  }, [filePath])

  const handleCopyMessage = useCallback(() => {
    if (onCopyMessage) {
      void Promise.resolve(onCopyMessage()).catch(() => {
        toast.error('Failed to copy')
      })
      return
    }
    const text = messageText.trim()
    if (!text) return
    void copyToClipboard(text)
      .then(() => toast.success('Copied to clipboard'))
      .catch(() => toast.error('Failed to copy'))
  }, [messageText, onCopyMessage])

  const canCopyMessage = Boolean(onCopyMessage || messageText.trim())
  const canCopySelection = selection.length > 0

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger
        asChild
        onContextMenu={captureMenuTarget}
        onPointerDown={captureMenuTarget}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {filePath && (
          <ContextMenuItem onSelect={handleDownloadFile}>
            <Download className="h-4 w-4" />
            Download file
          </ContextMenuItem>
        )}
        {linkUrl && (
          <ContextMenuItem onSelect={handleCopyUrl}>
            <Copy className="h-4 w-4" />
            Copy URL
          </ContextMenuItem>
        )}
        {canCopySelection && (
          <ContextMenuItem onSelect={handleCopySelection}>
            <Copy className="h-4 w-4" />
            Copy
          </ContextMenuItem>
        )}
        {canCopyMessage && (
          <ContextMenuItem onSelect={handleCopyMessage}>
            <Copy className="h-4 w-4" />
            {copyMessageLabel}
          </ContextMenuItem>
        )}
        {!canCopySelection && !canCopyMessage && (
          <ContextMenuItem disabled>No text to copy</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
