import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  codexModelOptions,
  getModelFastInfo,
  modelOptions,
  type CliBackend,
} from '@/types/preferences'

export const MODEL_CATALOG_URL =
  'https://raw.githubusercontent.com/coollabsio/coollabs-cdn/main/json/jean/models.json'

const MODEL_CATALOG_CACHE_KEY = 'jean:model-catalog:v1'
const MODEL_CATALOG_REFRESH_MS = 1000 * 60 * 60
const MODEL_CATALOG_TIMEOUT_MS = 8000

type CatalogBackend = Extract<CliBackend, 'claude' | 'codex'>

export interface ModelCatalogModel {
  id: string
  label: string
  fast_id?: string
  supports_fast?: boolean
  supports_images?: boolean
  supports_thinking?: boolean
  recommended?: boolean
  deprecated?: boolean
  hidden?: boolean
}

export interface ModelCatalogBackend {
  models: ModelCatalogModel[]
}

export interface ModelCatalog {
  version: 1
  updated_at: string
  defaults: Partial<Record<CatalogBackend, string>>
  backends: Partial<Record<CatalogBackend, ModelCatalogBackend>>
}

interface CachedModelCatalog {
  fetched_at: string
  catalog: ModelCatalog
}

interface FetchModelCatalogOptions {
  fetchImpl?: typeof fetch
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  cacheBust?: boolean
}

export const modelCatalogQueryKeys = {
  all: ['model-catalog'] as const,
}

const fallbackModelCatalog: ModelCatalog = {
  version: 1,
  updated_at: 'bundled',
  defaults: {
    claude: 'claude-opus-4-8[1m]',
    codex: 'gpt-5.5',
  },
  backends: {
    claude: {
      models: modelOptions.map(option => ({
        id: option.value,
        label: option.label,
        ...fastMetadataFor('claude', option.value),
      })),
    },
    codex: {
      models: codexModelOptions.map(option => ({
        id: option.value,
        label: option.label,
        ...fastMetadataFor('codex', option.value),
      })),
    },
  },
}

function fastMetadataFor(backend: CatalogBackend, model: string) {
  const info = getModelFastInfo(backend, model)
  return info.supportsFast && info.fastModel
    ? { supports_fast: true, fast_id: info.fastModel }
    : { supports_fast: false }
}

function getDefaultStorage() {
  if (typeof window === 'undefined') return undefined
  return window.localStorage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseModelCatalog(value: unknown): ModelCatalog | null {
  if (!isRecord(value)) return null
  if (value.version !== 1) return null
  if (typeof value.updated_at !== 'string') return null
  if (!isRecord(value.backends)) return null
  if (!isRecord(value.defaults)) return null

  const backends: Partial<Record<CatalogBackend, ModelCatalogBackend>> = {}
  for (const backend of ['claude', 'codex'] as const) {
    const rawBackend = value.backends[backend]
    if (!isRecord(rawBackend)) continue
    const rawModels = rawBackend.models
    if (!Array.isArray(rawModels)) continue
    const models = rawModels.flatMap(model => {
      if (!isRecord(model)) return []
      if (typeof model.id !== 'string' || typeof model.label !== 'string') {
        return []
      }
      const parsed: ModelCatalogModel = {
        id: model.id,
        label: model.label,
      }
      if (typeof model.fast_id === 'string') parsed.fast_id = model.fast_id
      if (typeof model.supports_fast === 'boolean') {
        parsed.supports_fast = model.supports_fast
      }
      if (typeof model.supports_images === 'boolean') {
        parsed.supports_images = model.supports_images
      }
      if (typeof model.supports_thinking === 'boolean') {
        parsed.supports_thinking = model.supports_thinking
      }
      if (typeof model.recommended === 'boolean') {
        parsed.recommended = model.recommended
      }
      if (typeof model.deprecated === 'boolean')
        parsed.deprecated = model.deprecated
      if (typeof model.hidden === 'boolean') parsed.hidden = model.hidden
      return [parsed]
    })
    if (models.length > 0) backends[backend] = { models }
  }

  const defaults: Partial<Record<CatalogBackend, string>> = {}
  for (const backend of ['claude', 'codex'] as const) {
    const rawDefault = value.defaults[backend]
    if (typeof rawDefault === 'string') defaults[backend] = rawDefault
  }

  return {
    version: 1,
    updated_at: value.updated_at,
    defaults,
    backends,
  }
}

function cacheModelCatalog(
  catalog: ModelCatalog,
  storage?: Pick<Storage, 'setItem'>
) {
  if (!storage) return
  const cached: CachedModelCatalog = {
    fetched_at: new Date().toISOString(),
    catalog,
  }
  storage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify(cached))
}

export function readCachedModelCatalog(
  storage: Pick<Storage, 'getItem'> | undefined = getDefaultStorage()
): ModelCatalog | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(MODEL_CATALOG_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return null
    return parseModelCatalog(parsed.catalog)
  } catch {
    return null
  }
}

export function clearCachedModelCatalog(
  storage: Pick<Storage, 'removeItem'> | undefined = getDefaultStorage()
) {
  storage?.removeItem(MODEL_CATALOG_CACHE_KEY)
}

function getModelCatalogUrl(cacheBust: boolean): string {
  if (!cacheBust) return MODEL_CATALOG_URL
  const separator = MODEL_CATALOG_URL.includes('?') ? '&' : '?'
  return `${MODEL_CATALOG_URL}${separator}t=${Date.now()}`
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  cacheBust: boolean
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_TIMEOUT_MS)
  try {
    return await fetchImpl(getModelCatalogUrl(cacheBust), {
      signal: controller.signal,
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchModelCatalog({
  fetchImpl = fetch,
  storage = getDefaultStorage(),
  cacheBust = false,
}: FetchModelCatalogOptions = {}): Promise<ModelCatalog> {
  try {
    const response = await fetchWithTimeout(fetchImpl, cacheBust)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed = parseModelCatalog(await response.json())
    if (!parsed) throw new Error('Invalid model catalog')
    cacheModelCatalog(parsed, storage)
    return parsed
  } catch {
    return readCachedModelCatalog(storage) ?? fallbackModelCatalog
  }
}

export function refreshModelCatalog(
  options: Omit<FetchModelCatalogOptions, 'cacheBust'> = {}
): Promise<ModelCatalog> {
  return fetchModelCatalog({ ...options, cacheBust: true })
}

export function useModelCatalog() {
  return useQuery({
    queryKey: modelCatalogQueryKeys.all,
    queryFn: () => fetchModelCatalog(),
    staleTime: MODEL_CATALOG_REFRESH_MS,
    refetchInterval: MODEL_CATALOG_REFRESH_MS,
    refetchOnWindowFocus: false,
  })
}

export function useRefreshModelCatalog() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => refreshModelCatalog(),
    onSuccess: catalog => {
      queryClient.setQueryData(modelCatalogQueryKeys.all, catalog)
    },
  })
}

export function getCatalogModelOptions(
  catalog: ModelCatalog | null | undefined,
  backend: CatalogBackend
): { value: string; label: string }[] {
  const source = catalog ?? fallbackModelCatalog
  const models = source.backends[backend]?.models
  if (!models?.length) {
    return getCatalogModelOptions(fallbackModelCatalog, backend)
  }
  return models
    .filter(model => !model.hidden)
    .map(model => ({ value: model.id, label: model.label }))
}

export function getCatalogDefaultModelOptions(
  catalog: ModelCatalog | null | undefined,
  backend: CatalogBackend
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = []
  const source = catalog ?? fallbackModelCatalog
  const models = source.backends[backend]?.models
  if (!models?.length) {
    return getCatalogDefaultModelOptions(fallbackModelCatalog, backend)
  }

  for (const model of models) {
    if (model.hidden) continue
    options.push({ value: model.id, label: model.label })
    if (model.fast_id) {
      options.push({
        value: model.fast_id,
        label: `${model.label} Fast`,
      })
    }
  }

  return options
}

export function getCatalogModelFastInfo(
  catalog: ModelCatalog | null | undefined,
  backend: CatalogBackend | CliBackend,
  model: string
) {
  if (backend !== 'claude' && backend !== 'codex') {
    return getModelFastInfo(backend, model)
  }

  const source = catalog ?? fallbackModelCatalog
  const models = source.backends[backend]?.models ?? []
  const base = models.find(entry => entry.id === model)
  if (base) {
    if (base.fast_id || base.supports_fast) {
      return {
        supportsFast: true,
        isFast: false,
        baseModel: base.id,
        fastModel: base.fast_id,
      }
    }
    return { supportsFast: false, isFast: false, baseModel: model }
  }

  const fastBase = models.find(entry => entry.fast_id === model)
  if (fastBase) {
    return {
      supportsFast: true,
      isFast: true,
      baseModel: fastBase.id,
      fastModel: model,
    }
  }

  return getModelFastInfo(backend, model)
}
