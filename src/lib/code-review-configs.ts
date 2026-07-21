import type {
  MagicCodeReviewConfig,
  MagicPromptModel,
} from '@/types/preferences'

const MAX_CODE_REVIEW_CONFIGS = 5

export function codeReviewConfigKey(config: MagicCodeReviewConfig): string {
  return `${config.backend}\u0000${config.model}`
}

export function resolveCodeReviewConfigs({
  configured,
  fallbackBackend,
  fallbackModel,
}: {
  configured: MagicCodeReviewConfig[] | undefined
  fallbackBackend: string
  fallbackModel: MagicPromptModel
}): MagicCodeReviewConfig[] {
  const configs = configured?.length
    ? configured
    : [{ backend: fallbackBackend, model: fallbackModel }]
  const seen = new Set<string>()

  return configs.filter(config => {
    const key = codeReviewConfigKey(config)
    if (seen.has(key) || seen.size >= MAX_CODE_REVIEW_CONFIGS) return false
    seen.add(key)
    return true
  })
}

export async function startCodeReviewsSequentially<T>(
  configs: T[],
  startReview: (config: T) => Promise<void>
): Promise<void> {
  const errors: unknown[] = []

  for (const config of configs) {
    try {
      await startReview(config)
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length > 0) throw new AggregateError(errors)
}

export function getCodeReviewSessionName(
  config: MagicCodeReviewConfig
): string {
  const backend =
    config.backend === 'commandcode'
      ? 'Command Code'
      : config.backend === 'opencode'
        ? 'OpenCode'
        : config.backend.charAt(0).toUpperCase() + config.backend.slice(1)
  return `Code Review · ${backend} · ${config.model}`
}
