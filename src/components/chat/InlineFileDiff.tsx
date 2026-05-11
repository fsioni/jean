import { useMemo } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import { createPatch } from 'diff'
import { useTheme } from '@/hooks/use-theme'
import { usePreferences } from '@/services/preferences'

interface InlineFileDiffBase {
  /** Tailwind max-height utility (e.g. "max-h-64", "max-h-none"). Default: "max-h-64". */
  maxHeightClass?: string
  /** Render without red/green diff accents. Used for compact chat tool calls. */
  neutral?: boolean
}

type InlineFileDiffProps = InlineFileDiffBase &
  (
    | { patch: string; filePath?: string; oldString?: never; newString?: never }
    | {
        patch?: never
        filePath: string
        oldString: string
        newString: string
      }
  )

/** Ensure a unified patch has `--- a/file` / `+++ b/file` headers so parsePatchFiles can identify the file. */
function ensurePatchHeaders(
  patch: string,
  filePath: string | undefined
): string {
  const trimmed = patch.replace(/^\n+/, '')
  if (trimmed.startsWith('---') || trimmed.startsWith('Index:')) {
    return patch
  }
  const name = filePath || 'file'
  return `--- a/${name}\n+++ b/${name}\n${patch}`
}

/**
 * Inline diff renderer for chat tool calls (Edit, File Change).
 * Uses @pierre/diffs/react <FileDiff> so styling matches GitDiffModal/FileDiffModal.
 */
export function InlineFileDiff(props: InlineFileDiffProps) {
  const { theme } = useTheme()
  const { data: preferences } = usePreferences()
  const neutral = props.neutral ?? false

  const resolvedThemeType = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    let raw: string

    if ('patch' in props && props.patch) {
      raw = ensurePatchHeaders(props.patch, props.filePath)
    } else if ('filePath' in props && props.filePath) {
      raw = createPatch(
        props.filePath,
        props.oldString ?? '',
        props.newString ?? '',
        undefined,
        undefined,
        { context: 3 }
      )
    } else {
      return null
    }

    try {
      const parsed = parsePatchFiles(raw)
      for (const patchEntry of parsed) {
        if (patchEntry.files.length > 0) {
          return patchEntry.files[0] ?? null
        }
      }
      return null
    } catch (err) {
      console.error('Failed to parse inline diff patch:', err)
      return null
    }
  }, [props])

  const options = useMemo(
    () => ({
      theme: {
        dark: preferences?.syntax_theme_dark ?? 'vitesse-black',
        light: preferences?.syntax_theme_light ?? 'github-light',
      },
      themeType: resolvedThemeType,
      diffStyle: 'unified' as const,
      overflow: 'wrap' as const,
      enableLineSelection: false,
      disableFileHeader: true,
      diffIndicators: neutral ? ('none' as const) : undefined,
      disableBackground: neutral,
      lineDiffType: neutral ? ('none' as const) : undefined,
      unsafeCSS: `
        pre { font-family: var(--font-family-mono) !important; font-size: calc(var(--ui-font-size) * 0.85) !important; line-height: var(--ui-line-height) !important; }
        * { user-select: text !important; -webkit-user-select: text !important; cursor: text !important; }
        ${
          neutral
            ? `
        [data-diffs],
        [data-diffs-header] {
          --diffs-deletion-color-override: var(--muted-foreground);
          --diffs-addition-color-override: var(--muted-foreground);
          --diffs-modified-color-override: var(--muted-foreground);
          --diffs-fg-number-addition-override: var(--muted-foreground);
          --diffs-fg-number-deletion-override: var(--muted-foreground);
          --diffs-bg-deletion-emphasis-override: transparent;
          --diffs-bg-addition-emphasis-override: transparent;
          --diffs-bg-deletion-override: transparent;
          --diffs-bg-addition-override: transparent;
          --diffs-bg-deletion-number-override: transparent;
          --diffs-bg-addition-number-override: transparent;
        }
        `
            : ''
        }
      `,
    }),
    [
      neutral,
      resolvedThemeType,
      preferences?.syntax_theme_dark,
      preferences?.syntax_theme_light,
    ]
  )

  if (!fileDiff) {
    return (
      <div className="rounded border border-border/30 px-2 py-1.5 text-xs text-muted-foreground/70 italic">
        No diff available
      </div>
    )
  }

  const maxHeightClass = props.maxHeightClass ?? 'max-h-64'

  return (
    <div
      className={`rounded border border-border/30 overflow-auto ${maxHeightClass}`}
    >
      <FileDiff fileDiff={fileDiff} options={options} />
    </div>
  )
}
