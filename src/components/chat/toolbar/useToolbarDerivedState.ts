import { useMemo } from 'react'
import {
  getModelFastInfo,
  type ClaudeModel,
  type CliBackend,
  type CustomCliProfile,
} from '@/types/preferences'
import {
  CODEX_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  COMMANDCODE_MODEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { sortModelOptionsByRawModel } from '@/components/chat/toolbar/toolbar-utils'

interface UseToolbarDerivedStateArgs {
  selectedBackend: CliBackend
  selectedProvider: string | null
  selectedModel: string
  opencodeModelOptions?: { value: string; label: string }[]
  cursorModelOptions?: { value: string; label: string }[]
  piModelOptions?: { value: string; label: string }[]
  commandcodeModelOptions?: { value: string; label: string }[]
  customCliProfiles: CustomCliProfile[]
  installedBackends?: CliBackend[]
  availableMcpServers?: { name: string; disabled?: boolean }[]
  enabledMcpServers?: string[]
}

export interface BackendModelSection {
  backend: CliBackend
  label: string
  options: { value: string; label: string }[]
}

export function buildBackendModelSections({
  installedBackends,
  claudeModelOptions,
  codexModelOptions,
  opencodeModelOptions,
  cursorModelOptions,
  piModelOptions,
  commandcodeModelOptions,
}: {
  installedBackends: CliBackend[]
  claudeModelOptions: { value: string; label: string }[]
  codexModelOptions: { value: string; label: string }[]
  opencodeModelOptions: { value: string; label: string }[]
  cursorModelOptions: { value: string; label: string }[]
  piModelOptions?: { value: string; label: string }[]
  commandcodeModelOptions?: { value: string; label: string }[]
}): BackendModelSection[] {
  const sections: BackendModelSection[] = []

  for (const backend of installedBackends) {
    if (backend === 'claude') {
      sections.push({ backend, label: 'Claude', options: claudeModelOptions })
    } else if (backend === 'codex') {
      sections.push({ backend, label: 'Codex', options: codexModelOptions })
    } else if (backend === 'opencode') {
      sections.push({
        backend,
        label: 'OpenCode',
        options: opencodeModelOptions,
      })
    } else if (backend === 'cursor') {
      sections.push({ backend, label: 'Cursor', options: cursorModelOptions })
    } else if (backend === 'pi') {
      sections.push({
        backend,
        label: 'PI',
        options: piModelOptions ?? PI_MODEL_OPTIONS,
      })
    } else if (backend === 'commandcode') {
      sections.push({
        backend,
        label: 'Command Code',
        options: commandcodeModelOptions ?? COMMANDCODE_MODEL_OPTIONS,
      })
    }
  }

  return sections
}

export function useToolbarDerivedState({
  selectedBackend,
  selectedProvider,
  selectedModel,
  opencodeModelOptions,
  cursorModelOptions,
  piModelOptions,
  commandcodeModelOptions,
  customCliProfiles,
  installedBackends = [
    'claude',
    'codex',
    'opencode',
    'cursor',
    'pi',
    'commandcode',
  ],
  availableMcpServers = [],
  enabledMcpServers = [],
}: UseToolbarDerivedStateArgs) {
  const isCodex = selectedBackend === 'codex'
  const isOpencode = selectedBackend === 'opencode'
  const isCursor = selectedBackend === 'cursor'
  const isPi = selectedBackend === 'pi'
  const isCommandCode = selectedBackend === 'commandcode'

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

  const codexModelOptions = sortModelOptionsByRawModel(
    CODEX_MODEL_OPTIONS as { value: string; label: string }[]
  )
  const resolvedOpencodeModelOptions = sortModelOptionsByRawModel(
    opencodeModelOptions ?? OPENCODE_MODEL_OPTIONS
  )
  const resolvedCursorModelOptions = sortModelOptionsByRawModel(
    cursorModelOptions ?? CURSOR_MODEL_OPTIONS
  )
  const resolvedPiModelOptions = sortModelOptionsByRawModel(
    piModelOptions ?? PI_MODEL_OPTIONS
  )
  const resolvedCommandCodeModelOptions =
    commandcodeModelOptions ?? COMMANDCODE_MODEL_OPTIONS

  const backendModelSections = useMemo(
    () =>
      buildBackendModelSections({
        installedBackends,
        claudeModelOptions,
        codexModelOptions,
        opencodeModelOptions: resolvedOpencodeModelOptions,
        cursorModelOptions: resolvedCursorModelOptions,
        piModelOptions: resolvedPiModelOptions,
        commandcodeModelOptions: resolvedCommandCodeModelOptions,
      }),
    [
      claudeModelOptions,
      codexModelOptions,
      installedBackends,
      resolvedCursorModelOptions,
      resolvedCommandCodeModelOptions,
      resolvedOpencodeModelOptions,
      resolvedPiModelOptions,
    ]
  )

  const filteredModelOptions = useMemo(() => {
    if (isCodex) return codexModelOptions
    if (isOpencode) return resolvedOpencodeModelOptions
    if (isCursor) return resolvedCursorModelOptions
    if (isPi) return resolvedPiModelOptions
    if (isCommandCode) return resolvedCommandCodeModelOptions
    return claudeModelOptions
  }, [
    claudeModelOptions,
    codexModelOptions,
    isCodex,
    isCursor,
    isPi,
    isCommandCode,
    isOpencode,
    resolvedCommandCodeModelOptions,
    resolvedCursorModelOptions,
    resolvedOpencodeModelOptions,
    resolvedPiModelOptions,
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
    isPi,
    isCommandCode,
    isOpencode,
    activeMcpCount,
    backendModelSections,
    claudeModelOptions,
    cursorModelOptions: resolvedCursorModelOptions,
    commandcodeModelOptions: resolvedCommandCodeModelOptions,
    filteredModelOptions,
    opencodeModelOptions: resolvedOpencodeModelOptions,
    piModelOptions: resolvedPiModelOptions,
    selectedModelLabel,
  }
}
