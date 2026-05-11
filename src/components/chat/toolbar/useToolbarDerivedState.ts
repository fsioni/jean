import { useMemo } from 'react'
import {
  getModelFastInfo,
  type ClaudeModel,
  type CustomCliProfile,
} from '@/types/preferences'
import {
  CODEX_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'

interface UseToolbarDerivedStateArgs {
  selectedBackend: 'claude' | 'codex' | 'opencode' | 'cursor'
  selectedProvider: string | null
  selectedModel: string
  opencodeModelOptions?: { value: string; label: string }[]
  cursorModelOptions?: { value: string; label: string }[]
  customCliProfiles: CustomCliProfile[]
  installedBackends?: ('claude' | 'codex' | 'opencode' | 'cursor')[]
  availableMcpServers?: { name: string; disabled?: boolean }[]
  enabledMcpServers?: string[]
}

export function useToolbarDerivedState({
  selectedBackend,
  selectedProvider,
  selectedModel,
  opencodeModelOptions,
  cursorModelOptions,
  customCliProfiles,
  installedBackends = ['claude', 'codex', 'opencode', 'cursor'],
  availableMcpServers = [],
  enabledMcpServers = [],
}: UseToolbarDerivedStateArgs) {
  const isCodex = selectedBackend === 'codex'
  const isOpencode = selectedBackend === 'opencode'
  const isCursor = selectedBackend === 'cursor'

  const activeMcpCount = useMemo(() => {
    const availableNames = new Set(
      availableMcpServers.filter(s => !s.disabled).map(s => s.name)
    )
    return enabledMcpServers.filter(name => availableNames.has(name)).length
  }, [availableMcpServers, enabledMcpServers])

  const claudeModelOptions = useMemo(() => {
    if (!selectedProvider || selectedProvider === '__anthropic__') {
      return MODEL_OPTIONS
    }

    const profile = customCliProfiles.find(p => p.name === selectedProvider)
    let opusModel: string | undefined
    let sonnetModel: string | undefined
    let haikuModel: string | undefined
    if (profile?.settings_json) {
      try {
        const settings = JSON.parse(profile.settings_json)
        const env = settings?.env
        if (env) {
          opusModel = env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL
          sonnetModel =
            env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL
          haikuModel = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL
        }
      } catch {
        // ignore parse errors
      }
    }

    const suffix = (model?: string) => (model ? ` (${model})` : '')
    return [
      { value: 'opus' as ClaudeModel, label: `Opus${suffix(opusModel)}` },
      { value: 'sonnet' as ClaudeModel, label: `Sonnet${suffix(sonnetModel)}` },
      { value: 'haiku' as ClaudeModel, label: `Haiku${suffix(haikuModel)}` },
    ]
  }, [selectedProvider, customCliProfiles])

  const codexModelOptions = CODEX_MODEL_OPTIONS as {
    value: string
    label: string
  }[]
  const resolvedOpencodeModelOptions =
    opencodeModelOptions ?? OPENCODE_MODEL_OPTIONS
  const resolvedCursorModelOptions = cursorModelOptions ?? CURSOR_MODEL_OPTIONS

  const backendModelSections = useMemo(() => {
    const sections: {
      backend: 'claude' | 'codex' | 'opencode' | 'cursor'
      label: string
      options: { value: string; label: string }[]
    }[] = []

    for (const backend of installedBackends) {
      if (backend === 'claude') {
        sections.push({
          backend,
          label: 'Claude',
          options: claudeModelOptions,
        })
      } else if (backend === 'codex') {
        sections.push({
          backend,
          label: 'Codex',
          options: codexModelOptions,
        })
      } else if (backend === 'opencode') {
        sections.push({
          backend,
          label: 'OpenCode',
          options: resolvedOpencodeModelOptions,
        })
      } else if (backend === 'cursor') {
        sections.push({
          backend,
          label: 'Cursor',
          options: resolvedCursorModelOptions,
        })
      }
    }

    return sections
  }, [
    claudeModelOptions,
    codexModelOptions,
    installedBackends,
    resolvedCursorModelOptions,
    resolvedOpencodeModelOptions,
  ])

  const filteredModelOptions = useMemo(() => {
    if (isCodex) return codexModelOptions
    if (isOpencode) return resolvedOpencodeModelOptions
    if (isCursor) return resolvedCursorModelOptions
    return claudeModelOptions
  }, [
    claudeModelOptions,
    codexModelOptions,
    isCodex,
    isCursor,
    isOpencode,
    resolvedCursorModelOptions,
    resolvedOpencodeModelOptions,
  ])

  // Fast variants share a label with their base model (the Zap indicator
  // distinguishes them visually). Applies to both Codex and Claude.
  const fastInfo = getModelFastInfo(selectedBackend, selectedModel)
  const labelLookupKey = fastInfo.isFast ? fastInfo.baseModel : selectedModel

  const selectedModelLabel =
    filteredModelOptions.find(o => o.value === labelLookupKey)?.label ??
    labelLookupKey

  return {
    isCodex,
    isCursor,
    isOpencode,
    activeMcpCount,
    backendModelSections,
    claudeModelOptions,
    cursorModelOptions: resolvedCursorModelOptions,
    filteredModelOptions,
    opencodeModelOptions: resolvedOpencodeModelOptions,
    selectedModelLabel,
  }
}
