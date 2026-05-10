import {
  CODEX_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { formatOpencodeModelLabel } from '@/components/chat/toolbar/toolbar-utils'
import { codexDefaultModelOptions } from '@/types/preferences'

const ALL_MODEL_OPTIONS = [
  ...MODEL_OPTIONS,
  ...CODEX_MODEL_OPTIONS,
  ...codexDefaultModelOptions,
  ...OPENCODE_MODEL_OPTIONS,
  ...CURSOR_MODEL_OPTIONS,
]

export function getMessageModelLabel(model: string): string {
  return (
    ALL_MODEL_OPTIONS.find(option => option.value === model)?.label ??
    (model.includes('/') ? formatOpencodeModelLabel(model) : model)
  )
}
