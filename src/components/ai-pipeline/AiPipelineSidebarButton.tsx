import { useCallback } from 'react'
import { Bot } from '@/components/icons/reicon'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUIStore } from '@/store/ui-store'
import { useAiPipelineProjectId } from '@/services/ai-pipeline'

/**
 * Permanent sidebar entry opening the AI pipeline
 * modal. Always targets the pinned project, so the same tickets show up
 * wherever it is opened from. Remains visible before ClickUp configuration
 * so setup guidance and the offline validation lab are always accessible.
 */
export function AiPipelineSidebarButton({ isNarrow }: { isNarrow: boolean }) {
  const isMobile = useIsMobile()
  const open = useUIStore(state => state.aiPipelineModalOpen)
  const { projectId } = useAiPipelineProjectId()

  const handleClick = useCallback(() => {
    const { setLeftSidebarVisible, setAiPipelineModalOpen } =
      useUIStore.getState()
    if (isMobile) setLeftSidebarVisible(false)
    setAiPipelineModalOpen(true, projectId ?? undefined)
  }, [isMobile, projectId])

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
