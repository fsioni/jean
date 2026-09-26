import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Plus, RefreshCw, Sparkles } from '@/components/icons/reicon'
import { Kbd } from '@/components/ui/kbd'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  type ContextMentionItem,
  useContextMentionData,
} from './hooks/useContextMentionData'

const githubContextQueries = new Set([
  'issues',
  'prs',
  'issue-search',
  'pr-search',
  'issue-by-number',
  'pr-by-number',
  'security-alerts',
  'security-alert',
  'advisories',
  'advisory',
])
const linearContextQueries = new Set([
  'issues',
  'issue-search',
  'issue-by-number',
])

export interface ContextMentionPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: (investigate?: boolean) => void
}

interface ContextMentionPopoverProps {
  projectPath: string | null
  projectId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectContext: (item: ContextMentionItem, investigate?: boolean) => void
  searchQuery: string
  anchorPosition: { top: number; left: number } | null
  containerWidth?: number
  handleRef?: React.RefObject<ContextMentionPopoverHandle | null>
}

export function ContextMentionPopover({
  projectPath,
  projectId,
  open,
  onOpenChange,
  onSelectContext,
  searchQuery,
  anchorPosition,
  containerWidth,
  handleRef,
}: ContextMentionPopoverProps) {
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const showKeyboardHints = isNativeApp() && !isMobile
  const [includeClosed, setIncludeClosed] = useState(false)
  const [menuSearch, setMenuSearch] = useState('')
  const [issueLimit, setIssueLimit] = useState(8)
  const [prLimit, setPrLimit] = useState(8)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const { groups, isFetching } = useContextMentionData({
    open,
    projectPath,
    projectId,
    query: menuSearch || searchQuery,
    includeClosed,
    issueLimit,
    prLimit,
  })
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const flatItems = useMemo(
    () => groups.flatMap(group => group.items),
    [groups]
  )

  const clampedSelectedIndex = Math.min(
    selectedIndex,
    Math.max(0, flatItems.length - 1)
  )

  const handleSelect = useCallback(
    (item: ContextMentionItem, investigate = false) => {
      onSelectContext(item, investigate)
      onOpenChange(false)
    },
    [onOpenChange, onSelectContext]
  )

  const handleRefresh = useCallback(async () => {
    if (!projectPath && !projectId) return
    setIsRefreshing(true)
    try {
      await queryClient.invalidateQueries(
        {
          predicate: ({ queryKey }) =>
            (Boolean(projectPath) &&
              queryKey[0] === 'github' &&
              queryKey[2] === projectPath &&
              githubContextQueries.has(String(queryKey[1]))) ||
            (Boolean(projectId) &&
              queryKey[0] === 'linear' &&
              queryKey[2] === projectId &&
              linearContextQueries.has(String(queryKey[1]))),
        },
        { throwOnError: true }
      )
    } catch (error) {
      toast.error(`Failed to refresh context links: ${error}`)
    } finally {
      setIsRefreshing(false)
    }
  }, [projectId, projectPath, queryClient])

  useEffect(() => {
    if (!open) return
    setSelectedIndex(0)
    setIssueLimit(8)
    setPrLimit(8)
  }, [open, searchQuery, menuSearch, includeClosed, projectPath])

  useEffect(() => {
    if (open) setMenuSearch('')
  }, [open])

  useImperativeHandle(
    handleRef,
    () => ({
      moveUp: () => setSelectedIndex(i => Math.max(i - 1, 0)),
      moveDown: () =>
        setSelectedIndex(i =>
          Math.min(i + 1, Math.max(0, flatItems.length - 1))
        ),
      selectCurrent: (investigate = false) => {
        const item = flatItems[clampedSelectedIndex]
        if (item) handleSelect(item, investigate)
      },
    }),
    [clampedSelectedIndex, flatItems, handleSelect]
  )

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list
      .querySelector(`[data-flat-index="${clampedSelectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelectedIndex])

  if (!open || !anchorPosition) return null

  let flatIndex = -1

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        className="-mx-4 md:-mx-6"
        style={{
          position: 'absolute',
          top: anchorPosition.top,
          left: 0,
          right: 0,
          pointerEvents: 'none',
        }}
      />
      <PopoverContent
        className="p-0"
        style={containerWidth ? { width: containerWidth } : undefined}
        align="start"
        collisionPadding={0}
        side="top"
        sideOffset={20}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            Context links
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Refresh context links"
              title="Refresh context links"
              disabled={isRefreshing || (!projectPath && !projectId)}
              onClick={() => void handleRefresh()}
              className="flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw
                className={cn('size-4', isRefreshing && 'animate-spin')}
              />
            </button>
            <button
              type="button"
              onClick={() => setIncludeClosed(value => !value)}
              className={cn(
                'rounded px-2 py-1 text-xs transition-colors',
                includeClosed
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {includeClosed
                ? 'Showing closed/merged'
                : 'Include closed/merged'}
            </button>
          </div>
        </div>
        <Command label="Search issues and context links" shouldFilter={false}>
          <CommandInput
            placeholder="Search issue title or description..."
            value={menuSearch}
            onValueChange={setMenuSearch}
            onKeyDown={event => {
              event.stopPropagation()
              switch (event.key) {
                case 'ArrowDown':
                  event.preventDefault()
                  setSelectedIndex(index =>
                    Math.min(index + 1, Math.max(0, flatItems.length - 1))
                  )
                  break
                case 'ArrowUp':
                  event.preventDefault()
                  setSelectedIndex(index => Math.max(index - 1, 0))
                  break
                case 'Enter': {
                  event.preventDefault()
                  const item = flatItems[clampedSelectedIndex]
                  if (item) handleSelect(item, event.shiftKey)
                  break
                }
                case 'Escape':
                  event.preventDefault()
                  onOpenChange(false)
                  break
              }
            }}
          />
          <CommandList
            ref={listRef}
            className="min-h-[280px] max-h-[min(420px,60vh)]"
          >
            {flatItems.length === 0 ? (
              <CommandEmpty>
                <div className="flex items-center justify-center gap-2">
                  {isFetching && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  <span>
                    {isFetching ? 'Searching contexts...' : 'No contexts found'}
                  </span>
                </div>
              </CommandEmpty>
            ) : (
              groups.map(group => (
                <CommandGroup key={group.id} heading={group.heading}>
                  {group.items.map(item => {
                    flatIndex += 1
                    const itemIndex = flatIndex
                    const Icon = item.icon
                    const isSelected = itemIndex === clampedSelectedIndex
                    return (
                      <CommandItem
                        key={item.id}
                        data-flat-index={itemIndex}
                        value={`${item.type}:${item.label}:${item.title}`}
                        onSelect={() => handleSelect(item)}
                        className={cn(
                          'flex items-center gap-2 cursor-pointer',
                          'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                          isSelected && '!bg-accent !text-accent-foreground'
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="shrink-0 text-xs font-mono text-muted-foreground">
                              {item.label}
                            </span>
                            <span className="truncate text-sm font-medium">
                              {item.title}
                            </span>
                          </div>
                          {item.subtitle && (
                            <div className="truncate text-xs text-muted-foreground">
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                        {item.badge && (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                            {item.badge}
                          </span>
                        )}
                        {(item.type === 'issue' || item.type === 'pr') && (
                          <span className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              aria-label={`Add ${item.label} to session context`}
                              title={`Add ${item.label} to session context`}
                              className="flex min-h-8 items-center gap-1 rounded px-1.5 hover:bg-muted"
                              onClick={event => {
                                event.stopPropagation()
                                handleSelect(item)
                              }}
                            >
                              <Plus className="size-3.5" />
                              {showKeyboardHints && isSelected && (
                                <Kbd>Enter</Kbd>
                              )}
                            </button>
                            <button
                              type="button"
                              aria-label={`Add ${item.label} and insert investigation prompt`}
                              title={`Add ${item.label} and insert investigation prompt`}
                              className="flex min-h-8 items-center gap-1 rounded px-1.5 hover:bg-muted"
                              onClick={event => {
                                event.stopPropagation()
                                handleSelect(item, true)
                              }}
                            >
                              <Sparkles className="size-3.5" />
                              {showKeyboardHints && isSelected && (
                                <Kbd>Shift+Enter</Kbd>
                              )}
                            </button>
                          </span>
                        )}
                      </CommandItem>
                    )
                  })}
                  {group.hasMore &&
                    (group.id === 'issue' || group.id === 'pr') && (
                      <button
                        type="button"
                        className="w-full rounded px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                        onClick={() => {
                          if (group.id === 'issue')
                            setIssueLimit(limit => limit + 8)
                          else setPrLimit(limit => limit + 8)
                        }}
                      >
                        Load more{' '}
                        {group.id === 'issue' ? 'issues' : 'pull requests'}
                      </button>
                    )}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
