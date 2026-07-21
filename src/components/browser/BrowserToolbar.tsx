import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  MousePointer2,
  Plus,
  RotateCw,
  X,
  XSquare,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { isBlankTabUrl, useBrowserStore } from '@/store/browser-store'
import { browserBackend, useBrowserTabActions } from '@/hooks/useBrowserPane'
import type { BrowserTab } from '@/types/browser'
import { toast } from 'sonner'

// Stable empty-array reference — see comment in BrowserView.tsx.
const EMPTY_TABS: BrowserTab[] = []

const displayUrl = (u: string): string => (isBlankTabUrl(u) ? '' : u)

interface BrowserToolbarProps {
  worktreeId: string
  className?: string
  /** Render close (X) button to dismiss the entire pane */
  onClose?: () => void
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed
  // Loopback hosts → http:// (local dev servers usually lack TLS).
  if (
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(trimmed)
  )
    return `http://${trimmed}`
  // If it has a dot and no spaces, treat as URL; else as Google search.
  if (/^[^\s]+\.[^\s]+/.test(trimmed)) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

const TabPill = memo(function TabPill({
  tab,
  isActive,
  onClick,
  onClose,
}: {
  tab: BrowserTab
  isActive: boolean
  onClick: () => void
  onClose: () => void
}) {
  let host = ''
  try {
    host = new URL(tab.url).host
  } catch {
    host = tab.url
  }
  const label = tab.title || host || 'New Tab'
  return (
    <div
      className={cn(
        'group flex h-7 max-w-[160px] cursor-default items-center gap-1.5 rounded-md border px-2 text-xs',
        isActive
          ? 'border-border bg-background text-foreground'
          : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted'
      )}
      onClick={onClick}
      title={tab.title || tab.url}
    >
      {tab.isLoading ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
      )}
      <span className="truncate">{label}</span>
      <button
        type="button"
        className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-60 hover:bg-muted-foreground/20 hover:opacity-100"
        onClick={e => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="Close tab"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
})

export const BrowserToolbar = memo(function BrowserToolbar({
  worktreeId,
  className,
  onClose,
}: BrowserToolbarProps) {
  const tabs = useBrowserStore(state => state.tabs[worktreeId] ?? EMPTY_TABS)
  const activeTabId = useBrowserStore(
    state => state.activeTabIds[worktreeId] ?? ''
  )
  const activeTab = tabs.find(t => t.id === activeTabId) ?? null

  const [draftUrl, setDraftUrl] = useState(displayUrl(activeTab?.url ?? ''))
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // When the active tab's URL changes externally (navigation), update the draft
  // unless the user is currently editing the input. Hide the synthetic
  // DEFAULT_NEW_TAB_URL data: URL — show an empty input instead.
  useEffect(() => {
    if (!editing) {
      setDraftUrl(displayUrl(activeTab?.url ?? ''))
    }
  }, [activeTab?.url, editing])

  // Auto-focus URL input when switching to (or opening) a blank tab so users
  // can start typing immediately.
  useEffect(() => {
    if (!activeTabId) return
    if (isBlankTabUrl(activeTab?.url ?? '')) {
      inputRef.current?.focus()
    }
    // intentionally only on tab switch — not on url updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId])

  const actions = useBrowserTabActions(activeTabId || null)

  const handleAddTab = useCallback(() => {
    // New tabs default to blank — port-based URL only used for the first
    // auto-created tab when the pane initially opens (see BrowserView).
    useBrowserStore.getState().addTab(worktreeId)
  }, [worktreeId])

  const handleSelectTab = useCallback(
    (tabId: string) => {
      useBrowserStore.getState().setActiveTab(worktreeId, tabId)
    },
    [worktreeId]
  )

  const handleCloseTab = useCallback(
    (tabId: string) => {
      useBrowserStore.getState().removeTab(worktreeId, tabId)
      void browserBackend.close(tabId)
    },
    [worktreeId]
  )

  const handleEnableGrab = useCallback(() => {
    void actions
      .enableGrab()
      .then(() => toast.success('Grab enabled for this browser tab'))
      .catch(error => toast.error(`Failed to enable Grab: ${error}`))
  }, [actions])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const target = normalizeUrl(draftUrl)
      if (!target) return
      void actions.navigate(target)
      setEditing(false)
    },
    [actions, draftUrl]
  )

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-1.5 border-b bg-card px-2 pt-1.5 pb-1.5',
        className
      )}
    >
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => void actions.back()}
          disabled={!activeTab}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => void actions.forward()}
          disabled={!activeTab}
          aria-label="Forward"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        {activeTab?.isLoading ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void actions.stop()}
            aria-label="Stop loading"
          >
            <XSquare className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void actions.reload()}
            disabled={!activeTab}
            aria-label="Reload"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleEnableGrab}
          disabled={!activeTab || isBlankTabUrl(activeTab.url)}
          aria-label="Grab DOM element"
          title="Grab DOM element"
        >
          <MousePointer2 className="h-4 w-4" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={handleSubmit}>
          <Input
            ref={inputRef}
            value={draftUrl}
            onChange={e => {
              setEditing(true)
              setDraftUrl(e.target.value)
            }}
            onFocus={e => {
              setEditing(true)
              e.currentTarget.select()
            }}
            onBlur={() => setEditing(false)}
            placeholder="Search or enter URL"
            className="h-7 px-2 text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={!activeTab}
          />
        </form>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            aria-label="Close browser"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto">
        {tabs.map(tab => (
          <TabPill
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onClick={() => handleSelectTab(tab.id)}
            onClose={() => handleCloseTab(tab.id)}
          />
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={handleAddTab}
          aria-label="New tab"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
})
