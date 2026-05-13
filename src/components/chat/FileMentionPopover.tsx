import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileIcon, FolderIcon } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { useWorktreeFiles, fileQueryKeys } from '@/services/files'
import type { WorktreeFile, PendingFile } from '@/types/chat'
import { useProjects } from '@/services/projects'
import { isFolder } from '@/types/projects'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/uuid'
import { getExtensionColor } from '@/lib/file-colors'
import { fuzzySearchFiles } from '@/lib/fuzzy-search'

export interface FileMentionPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: () => void
}

interface FileMentionPopoverProps {
  /** Worktree path for file listing */
  worktreePath: string | null
  /** Current project ID, used to show linked projects as selectable scopes */
  currentProjectId?: string | null
  /** Whether the popover is open */
  open: boolean
  /** Callback when popover should close */
  onOpenChange: (open: boolean) => void
  /** Callback when a file is selected */
  onSelectFile: (file: PendingFile) => void
  /** Current search query (text after @) */
  searchQuery: string
  /** Position for the anchor (relative to textarea container) */
  anchorPosition: { top: number; left: number } | null
  /** Width of the container (textarea) for popover sizing */
  containerWidth?: number
  /** Ref to expose navigation methods to parent */
  handleRef?: React.RefObject<FileMentionPopoverHandle | null>
}

interface FileMentionScope {
  id: string
  name: string
  rootPath: string
  isCurrent: boolean
}

export function FileMentionPopover({
  worktreePath,
  currentProjectId,
  open,
  onOpenChange,
  onSelectFile,
  searchQuery,
  anchorPosition,
  containerWidth,
  handleRef,
}: FileMentionPopoverProps) {
  const queryClient = useQueryClient()
  const { data: projects = [] } = useProjects()
  const [selectedRootPath, setSelectedRootPath] = useState<string | null>(
    worktreePath
  )
  const { data: files = [] } = useWorktreeFiles(selectedRootPath)
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const currentProject = useMemo(
    () => projects.find(p => p.id === currentProjectId) ?? null,
    [projects, currentProjectId]
  )

  const scopes = useMemo<FileMentionScope[]>(() => {
    const currentScopes: FileMentionScope[] = worktreePath
      ? [
          {
            id: currentProject?.id ?? 'current',
            name: currentProject?.name ?? 'Current worktree',
            rootPath: worktreePath,
            isCurrent: true,
          },
        ]
      : []

    const linkedIds = new Set(currentProject?.linked_project_ids ?? [])
    const linkedScopes = projects
      .filter(p => linkedIds.has(p.id) && !isFolder(p) && p.path)
      .map(p => ({
        id: p.id,
        name: p.name,
        rootPath: p.path,
        isCurrent: false,
      }))

    return [...currentScopes, ...linkedScopes]
  }, [currentProject, projects, worktreePath])

  const selectedScope = useMemo(
    () => scopes.find(scope => scope.rootPath === selectedRootPath) ?? null,
    [scopes, selectedRootPath]
  )

  useEffect(() => {
    if (open) {
      setSelectedRootPath(worktreePath)
      setSelectedIndex(scopes.length)
    }
  }, [open, scopes.length, worktreePath])

  // Refetch file list each time the popover opens so newly added files appear
  useEffect(() => {
    if (open && selectedRootPath) {
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.worktreeFiles(selectedRootPath),
      })
    }
  }, [open, selectedRootPath, queryClient])

  // Filter files based on search query (fuzzy match)
  const filteredFiles = useMemo(
    () => fuzzySearchFiles(files, searchQuery, 15),
    [files, searchQuery]
  )

  // Clamp selectedIndex to valid range (handles case when filter reduces results)
  const clampedSelectedIndex = Math.min(
    selectedIndex,
    Math.max(0, scopes.length + filteredFiles.length - 1)
  )

  const handleScopeSelect = useCallback(
    (scope: FileMentionScope) => {
      setSelectedRootPath(scope.rootPath)
      setSelectedIndex(scopes.length)
    },
    [scopes.length]
  )

  const handleSelect = useCallback(
    (file: WorktreeFile) => {
      const pendingFile: PendingFile = {
        id: generateId(),
        relativePath: file.relative_path,
        extension: file.extension,
        isDirectory: file.is_dir,
        ...(selectedScope && !selectedScope.isCurrent
          ? {
              sourceRootPath: selectedScope.rootPath,
              sourceProjectId: selectedScope.id,
              sourceProjectName: selectedScope.name,
            }
          : {}),
      }
      onSelectFile(pendingFile)
      onOpenChange(false)
    },
    [onSelectFile, onOpenChange, selectedScope]
  )

  // Expose navigation methods via ref for parent to call
  useImperativeHandle(handleRef, () => {
    return {
      moveUp: () => {
        setSelectedIndex(i => Math.max(i - 1, 0))
      },
      moveDown: () => {
        setSelectedIndex(i =>
          Math.min(i + 1, scopes.length + filteredFiles.length - 1)
        )
      },
      selectCurrent: () => {
        if (clampedSelectedIndex < scopes.length) {
          const scope = scopes[clampedSelectedIndex]
          if (scope) handleScopeSelect(scope)
          return
        }

        const file = filteredFiles[clampedSelectedIndex - scopes.length]
        if (file) {
          handleSelect(file)
        }
      },
    }
  }, [
    filteredFiles,
    scopes,
    clampedSelectedIndex,
    handleSelect,
    handleScopeSelect,
  ])

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    const selectedItem = list.querySelector(
      `[data-index="${clampedSelectedIndex}"]`
    )
    selectedItem?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelectedIndex])

  if (!open || !anchorPosition) return null

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
        <div className="flex min-h-[41px] items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            File links
          </span>
          {selectedScope && (
            <span className="max-w-[60%] truncate text-xs text-muted-foreground">
              Scope: {selectedScope.name}
            </span>
          )}
        </div>
        <Command shouldFilter={false}>
          <CommandList
            ref={listRef}
            className="min-h-[280px] max-h-[min(360px,60vh)]"
          >
            {scopes.length === 0 && filteredFiles.length === 0 ? (
              <CommandEmpty>No files found</CommandEmpty>
            ) : (
              <>
                {scopes.length > 0 && (
                  <CommandGroup heading="Projects">
                    {scopes.map((scope, index) => {
                      const isSelected = index === clampedSelectedIndex
                      const isActiveScope = scope.rootPath === selectedRootPath

                      return (
                        <CommandItem
                          key={`${scope.id}:${scope.rootPath}`}
                          data-index={index}
                          value={`project:${scope.name}`}
                          onSelect={() => handleScopeSelect(scope)}
                          className={cn(
                            'flex items-center gap-2 cursor-pointer',
                            'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                            isActiveScope &&
                              '!bg-primary/15 !text-foreground ring-1 ring-inset ring-primary/25',
                            isSelected && '!bg-accent !text-accent-foreground'
                          )}
                        >
                          <FolderIcon
                            className={cn(
                              'h-4 w-4 shrink-0',
                              isActiveScope
                                ? 'text-foreground/80'
                                : scope.isCurrent
                                  ? 'text-muted-foreground'
                                  : 'text-muted-foreground/80'
                            )}
                          />
                          <span className="truncate text-sm">
                            {scope.isCurrent
                              ? `${scope.name} (current)`
                              : scope.name}
                          </span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )}

                {filteredFiles.length === 0 ? (
                  <CommandEmpty>
                    No files found in selected project
                  </CommandEmpty>
                ) : (
                  <CommandGroup heading="Files">
                    {filteredFiles.map((file, index) => {
                      const itemIndex = scopes.length + index
                      const isSelected = itemIndex === clampedSelectedIndex
                      return (
                        <CommandItem
                          key={file.relative_path}
                          data-index={itemIndex}
                          value={file.relative_path}
                          onSelect={() => handleSelect(file)}
                          className={cn(
                            'flex items-center gap-2 cursor-pointer',
                            // Override cmdk's internal selection styling - we manage selection ourselves
                            'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                            isSelected && '!bg-accent !text-accent-foreground'
                          )}
                        >
                          {file.is_dir ? (
                            <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground/80" />
                          ) : (
                            <FileIcon
                              className={cn(
                                'h-4 w-4 shrink-0',
                                getExtensionColor(file.extension)
                              )}
                            />
                          )}
                          <span className="truncate text-sm">
                            {file.is_dir
                              ? `${file.relative_path}/`
                              : file.relative_path}
                          </span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
