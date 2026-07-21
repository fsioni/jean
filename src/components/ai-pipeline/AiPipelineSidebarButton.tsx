import { useCallback } from 'react'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUIStore } from '@/store/ui-store'
import {
  useAiPipelineProjectId,
  useHasAiPipelineAccess,
} from '@/services/ai-pipeline'

/**
 * Permanent sidebar entry (right under Mission Control) opening the AI pipeline
 * modal. Always targets the pinned project, so the same tickets show up
 * wherever it is opened from. Hidden until ClickUp is configured.
 */
export function AiPipelineSidebarButton({ isNarrow }: { isNarrow: boolean }) {
  const open = useUIStore(state => state.aiPipelineModalOpen)
  const hasAccess = useHasAiPipelineAccess()
  const { projectId } = useAiPipelineProjectId()

  const handleClick = useCallback(() => {
    useUIStore.getState().setAiPipelineModalOpen(true, projectId ?? undefined)
  }, [projectId])

  if (!hasAccess) return null

  const button = (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Pipeline IA"
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm transition-colors',
        isNarrow && 'justify-center px-0',
        open
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      )}
    >
      <Bot className="size-3.5 shrink-0" />
      {!isNarrow && (
        <span className="flex-1 truncate text-left">Pipeline IA</span>
      )}
    </button>
  )

  // When the label is hidden, surface the name via a tooltip.
  if (isNarrow) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">Pipeline IA</TooltipContent>
      </Tooltip>
    )
  }

  return button
}
