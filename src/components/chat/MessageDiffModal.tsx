import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { createPatch } from 'diff'
import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import {
  FileText,
  Columns2,
  Rows3,
  Loader2,
  ExternalLink,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getFilename } from '@/lib/path-utils'
import { getHunkLineStats } from '@/lib/diff-stats'
import { useTheme } from '@/hooks/use-theme'
import { usePreferences } from '@/services/preferences'
import { getGitDiff } from '@/services/git-status'
import { isTauri } from '@/services/projects'
import { invoke } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'

function DiffBlock({
  fileName,
  prevName,
  children,
}: {
  fileName: string
  prevName?: string
  children: ReactNode
}) {
  return (
    <div className="border border-border rounded overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted border-b border-border sticky top-0 z-10">
        <FileText className="h-[1em] w-[1em] shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-mono">{fileName}</span>
        {prevName && (
          <span className="text-muted-foreground truncate text-xs font-mono">
            ← {prevName}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

export interface EditTool {
  name: string
  input: {
    file_path: string
    old_string?: string
    new_string?: string
  }
}

/**
 * Replace the LAST occurrence of `search` with `replacement`.
 * Used for reverse-replaying edits: edits are undone newest-first, so the most
 * recently inserted text is the last occurrence. First-match `String.replace`
 * could revert the wrong instance when the inserted text is non-unique.
 */
function replaceLast(
  haystack: string,
  search: string,
  replacement: string
): string {
  const idx = haystack.lastIndexOf(search)
  if (idx === -1) return haystack
  return (
    haystack.slice(0, idx) + replacement + haystack.slice(idx + search.length)
  )
}

type DiffStyle = 'split' | 'unified'
type ViewMode = 'last' | 'all'

interface MessageDiffModalProps {
  isOpen: boolean
  onClose: () => void
  filePath: string
  edits: EditTool[]
  subsequentEdits?: EditTool[]
  worktreePath?: string
}

export function MessageDiffModal({
  isOpen,
  onClose,
  filePath,
  edits,
  subsequentEdits = [],
  worktreePath,
}: MessageDiffModalProps) {
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split')
  const [viewMode, setViewMode] = useState<ViewMode>('last')
  const { theme } = useTheme()
  const { data: preferences } = usePreferences()

  const resolvedThemeType = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  const relativePath = useMemo(() => {
    if (worktreePath && filePath.startsWith(worktreePath + '/')) {
      return filePath.slice(worktreePath.length + 1)
    }
    return getFilename(filePath)
  }, [filePath, worktreePath])

  // ── Current change: final file → reverse this message's edits → full-file diff ──
  const { data: fileContent, isLoading: isLoadingFile } = useQuery({
    queryKey: ['file-content', filePath],
    queryFn: () => invoke<string>('read_file_content', { path: filePath }),
    enabled: isOpen && viewMode === 'last',
    staleTime: 10_000,
  })

  const currentChangeFile = useMemo(() => {
    if (!fileContent) return null
    try {
      // Step 1: undo subsequent messages' edits → get file state right after THIS message
      let afterThis = fileContent
      for (const edit of [...subsequentEdits].reverse()) {
        const oldStr = edit.input.old_string ?? ''
        const newStr = edit.input.new_string ?? ''
        if (newStr && afterThis.includes(newStr)) {
          afterThis = replaceLast(afterThis, newStr, oldStr)
        }
      }
      // Step 2: undo this message's edits → get file state before THIS message
      let beforeThis = afterThis
      for (const edit of [...edits].reverse()) {
        const oldStr = edit.input.old_string ?? ''
        const newStr = edit.input.new_string ?? ''
        if (newStr && beforeThis.includes(newStr)) {
          beforeThis = replaceLast(beforeThis, newStr, oldStr)
        }
      }
      const patch = createPatch(relativePath, beforeThis, afterThis, '', '', {
        context: 3,
      })
      const patches = parsePatchFiles(patch)
      return patches[0]?.files[0] ?? null
    } catch {
      return null
    }
  }, [fileContent, edits, subsequentEdits, relativePath])

  // ── All changes: full uncommitted git diff ───────────────────────────────
  const { data: gitDiff, isLoading: isLoadingGit } = useQuery({
    queryKey: ['git-diff', worktreePath, 'uncommitted'],
    queryFn: () => {
      if (!worktreePath) {
        throw new Error('worktreePath is required to load git diff')
      }
      return getGitDiff(worktreePath, 'uncommitted')
    },
    enabled: viewMode === 'all' && !!worktreePath && isTauri(),
    staleTime: 30_000,
  })

  const allChangesFile = useMemo(() => {
    if (!gitDiff?.raw_patch) return null
    try {
      const patches = parsePatchFiles(gitDiff.raw_patch)
      for (const patch of patches) {
        for (const file of patch.files) {
          const name = file.name || file.prevName || ''
          const relative = filePath.startsWith((worktreePath ?? '') + '/')
            ? filePath.slice((worktreePath?.length ?? 0) + 1)
            : filePath
          if (
            name === relative ||
            name === filePath ||
            name.endsWith(`/${relative}`) ||
            relative.endsWith(`/${name}`)
          ) {
            return file
          }
        }
      }
    } catch {
      return null
    }
    return null
  }, [gitDiff?.raw_patch, filePath, worktreePath])

  const currentStats = useMemo(
    () =>
      currentChangeFile ? getHunkLineStats(currentChangeFile.hunks) : null,
    [currentChangeFile]
  )

  const allStats = useMemo(
    () => (allChangesFile ? getHunkLineStats(allChangesFile.hunks) : null),
    [allChangesFile]
  )

  const fileDiffOptions = useMemo(
    () => ({
      theme: {
        dark: preferences?.syntax_theme_dark ?? 'vitesse-black',
        light: preferences?.syntax_theme_light ?? 'github-light',
      },
      themeType: resolvedThemeType,
      diffStyle,
      overflow: 'wrap' as const,
      enableLineSelection: false,
      disableFileHeader: true,
      unsafeCSS: `
        pre { font-family: var(--font-family-mono) !important; font-size: calc(var(--ui-font-size) * 0.85) !important; line-height: var(--ui-line-height) !important; }
        * { user-select: text !important; -webkit-user-select: text !important; cursor: text !important; }
      `,
    }),
    [
      resolvedThemeType,
      diffStyle,
      preferences?.syntax_theme_dark,
      preferences?.syntax_theme_light,
    ]
  )

  const openFileMutation = useMutation({
    mutationFn: () =>
      invoke('open_file_in_default_app', {
        path: filePath,
        editor: preferences?.editor,
      }),
  })

  const handleOpenExternal = useCallback(() => {
    const id = toast.loading('Opening in editor…')
    openFileMutation.mutate(undefined, {
      onSuccess: () => toast.success('Opened in editor', { id }),
      onError: err => {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Failed to open: ${message}`, { id })
      },
    })
  }, [openFileMutation])

  // "All changes" relies on the git backend, only available in the native app
  const allChangesAvailable = isTauri() && !!worktreePath

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent
        className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm overflow-hidden flex flex-col"
        style={{ fontSize: 'var(--ui-font-size)' }}
        showCloseButton={false}
      >
        <DialogTitle className="flex items-center gap-2 shrink-0 flex-wrap">
          <FileText className="h-4 w-4 shrink-0" />
          <span className="truncate">{getFilename(filePath)}</span>

          {/* View mode toggle */}
          <div className="flex items-center bg-muted rounded-lg p-1 ml-2">
            <button
              type="button"
              onClick={() => setViewMode('last')}
              className={cn(
                'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                viewMode === 'last'
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Current change
              {currentStats &&
                (currentStats.additions > 0 || currentStats.deletions > 0) && (
                  <span className="ml-1.5 font-mono opacity-80">
                    <span className="text-green-500">
                      +{currentStats.additions}
                    </span>
                    <span className="mx-0.5">/</span>
                    <span className="text-red-500">
                      -{currentStats.deletions}
                    </span>
                  </span>
                )}
            </button>
            {allChangesAvailable && (
              <button
                type="button"
                onClick={() => setViewMode('all')}
                className={cn(
                  'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                  viewMode === 'all'
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                All changes
                {allStats &&
                  (allStats.additions > 0 || allStats.deletions > 0) && (
                    <span className="ml-1.5 font-mono opacity-80">
                      <span className="text-green-500">
                        +{allStats.additions}
                      </span>
                      <span className="mx-0.5">/</span>
                      <span className="text-red-500">
                        -{allStats.deletions}
                      </span>
                    </span>
                  )}
              </button>
            )}
          </div>

          {/* Diff style toggle */}
          <div className="flex items-center bg-muted rounded-lg p-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setDiffStyle('split')}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    diffStyle === 'split'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  Split
                </button>
              </TooltipTrigger>
              <TooltipContent>Side-by-side view</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setDiffStyle('unified')}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    diffStyle === 'unified'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Rows3 className="h-3.5 w-3.5" />
                  Stacked
                </button>
              </TooltipTrigger>
              <TooltipContent>Unified view</TooltipContent>
            </Tooltip>
          </div>

          <div className="ml-auto flex items-center gap-1">
            {isNativeApp() && (
              <button
                type="button"
                onClick={handleOpenExternal}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                Open in Editor
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </div>
        </DialogTitle>

        <DialogDescription className="sr-only">
          Changes made to {relativePath} in this message.
        </DialogDescription>

        <div className="flex-1 min-h-0 mt-2 overflow-y-auto space-y-2">
          {viewMode === 'last' ? (
            isLoadingFile ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading diff…
              </div>
            ) : currentChangeFile ? (
              <DiffBlock fileName={relativePath}>
                <FileDiff
                  fileDiff={currentChangeFile}
                  options={fileDiffOptions}
                />
              </DiffBlock>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                No changes to display
              </div>
            )
          ) : isLoadingGit ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading diff…
            </div>
          ) : allChangesFile ? (
            <DiffBlock
              fileName={
                allChangesFile.name || allChangesFile.prevName || relativePath
              }
              prevName={
                allChangesFile.prevName &&
                allChangesFile.prevName !== allChangesFile.name
                  ? allChangesFile.prevName
                  : undefined
              }
            >
              <FileDiff fileDiff={allChangesFile} options={fileDiffOptions} />
            </DiffBlock>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              No uncommitted changes for this file
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
