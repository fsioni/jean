import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Loader2 } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  type ContextMentionItem,
  useContextMentionData,
} from './hooks/useContextMentionData'

export interface ContextMentionPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: () => void
}

interface ContextMentionPopoverProps {
  projectPath: string | null
  projectId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectContext: (item: ContextMentionItem) => void
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
  const [includeClosed, setIncludeClosed] = useState(false)
  const { groups, isFetching } = useContextMentionData({
    open,
    projectPath,
    projectId,
    query: searchQuery,
    includeClosed,
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
    (item: ContextMentionItem) => {
      onSelectContext(item)
      onOpenChange(false)
    },
    [onOpenChange, onSelectContext]
  )

  useEffect(() => {
    if (open) setSelectedIndex(0)
  }, [open, searchQuery])

  useImperativeHandle(
    handleRef,
    () => ({
      moveUp: () => setSelectedIndex(i => Math.max(i - 1, 0)),
      moveDown: () =>
        setSelectedIndex(i =>
          Math.min(i + 1, Math.max(0, flatItems.length - 1))
        ),
      selectCurrent: () => {
        const item = flatItems[clampedSelectedIndex]
        if (item) handleSelect(item)
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
            {includeClosed ? 'Showing closed/merged' : 'Include closed/merged'}
          </button>
        </div>
        <Command shouldFilter={false}>
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
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
