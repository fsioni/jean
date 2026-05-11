import {
  CODEX_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { formatOpencodeModelLabel } from '@/components/chat/toolbar/toolbar-utils'
import {
  codexDefaultModelOptions,
  getClaudeFastInfo,
} from '@/types/preferences'

const ALL_MODEL_OPTIONS = [
  ...MODEL_OPTIONS,
  ...CODEX_MODEL_OPTIONS,
  ...codexDefaultModelOptions,
  ...OPENCODE_MODEL_OPTIONS,
  ...CURSOR_MODEL_OPTIONS,
]

export function getMessageModelLabel(model: string): string {
  const directLabel = ALL_MODEL_OPTIONS.find(
    option => option.value === model
  )?.label
  if (directLabel) return directLabel

  const claudeFastInfo = getClaudeFastInfo(model)
  if (claudeFastInfo.isFast) {
    const baseLabel = ALL_MODEL_OPTIONS.find(
      option => option.value === claudeFastInfo.baseModel
    )?.label
    if (baseLabel) return `${baseLabel} Fast`
  }

  return model.includes('/') ? formatOpencodeModelLabel(model) : model
}
