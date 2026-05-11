import { memo } from 'react'
import {
  EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { getMessageModelLabel } from '@/components/chat/message-settings-labels'
import { isCodexModel } from '@/types/preferences'
import type { EffortLevel, ExecutionMode, ThinkingLevel } from '@/types/chat'

interface MessageSettingsBadgesProps {
  model: string | undefined
  executionMode: ExecutionMode | undefined
  thinkingLevel: ThinkingLevel | undefined
  effortLevel: EffortLevel | undefined
  isCursor: boolean
}

export const MessageSettingsBadges = memo(function MessageSettingsBadges({
  model,
  executionMode,
  thinkingLevel,
  effortLevel,
  isCursor,
}: MessageSettingsBadgesProps) {
  if (!model) return null

  const modelLabel = getMessageModelLabel(model)
  const isCodex = isCodexModel(model) || model.includes('codex')

  const effortLabel = effortLevel
    ? (EFFORT_LEVEL_OPTIONS.find(o => o.value === effortLevel)?.label ??
      effortLevel)
    : null

  const thinkingLabel =
    !isCodex && thinkingLevel && thinkingLevel !== 'off'
      ? (THINKING_LEVEL_OPTIONS.find(o => o.value === thinkingLevel)?.label ??
        thinkingLevel)
      : null

  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
      <span>{modelLabel}</span>
      {executionMode && <span className="capitalize">· {executionMode}</span>}
      {!isCursor && effortLabel && <span>· {effortLabel}</span>}
      {!isCursor && !effortLabel && thinkingLabel && (
        <span>· {thinkingLabel}</span>
      )}
    </div>
  )
})
