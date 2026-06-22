import { memo } from 'react'
import { Copy } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * Right-aligned card grouping one or more user prompts that were steered
 * into a running turn (Codex `turn/steer`). Consecutive steered prompts
 * render as connected rows in a single bubble so they read as one batch.
 */
export const SteeredPromptGroup = memo(function SteeredPromptGroup({
  texts,
  onCopyText,
}: {
  texts: string[]
  onCopyText?: (text: string) => void
}) {
  if (texts.length === 0) return null
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] sm:max-w-[70%] min-w-0 rounded-lg border border-border bg-muted/20 divide-y divide-border/60">
        {texts.map((text, i) => (
          <div
            key={i}
            className="relative group/steered px-3 py-2 text-foreground break-words whitespace-pre-wrap"
          >
            {onCopyText && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Copy steered prompt"
                    onClick={() => onCopyText(text)}
                    className="absolute right-full top-2 mr-1 p-1 rounded cursor-pointer text-muted-foreground/0 [@media(pointer:coarse)]:text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50 group-hover/steered:text-muted-foreground/50 transition-colors"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Copy to clipboard</TooltipContent>
              </Tooltip>
            )}
            {text}
          </div>
        ))}
      </div>
    </div>
  )
})
