import { describe, expect, it, vi } from 'vitest'
import {
  MODEL_CATALOG_URL,
  clearCachedModelCatalog,
  fetchModelCatalog,
  getCatalogDefaultModelOptions,
  getCatalogModelFastInfo,
  getCatalogModelOptions,
  readCachedModelCatalog,
} from './model-catalog'

function createStorage() {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
  } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

describe('model catalog', () => {
  it('fetches the GitHub CDN catalog and caches it', async () => {
    const storage = createStorage()
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      expect(String(url)).toBe(MODEL_CATALOG_URL)
      return new Response(
        JSON.stringify({
          version: 1,
          updated_at: '2026-06-09T00:00:00Z',
          defaults: { claude: 'claude-fable-5', codex: 'gpt-5.5' },
          backends: {
            claude: {
              models: [
                {
                  id: 'claude-fable-5',
                  label: 'Claude Fable 5',
                  supports_fast: false,
                },
              ],
            },
            codex: {
              models: [
                {
                  id: 'gpt-5.5',
                  label: 'GPT 5.5',
                  fast_id: 'gpt-5.5-fast',
                  supports_fast: true,
                },
              ],
            },
          },
        }),
        { status: 200 }
      )
    })

    const catalog = await fetchModelCatalog({ fetchImpl, storage })

    expect(getCatalogModelOptions(catalog, 'claude')).toEqual([
      { value: 'claude-fable-5', label: 'Claude Fable 5' },
    ])
    expect(getCatalogDefaultModelOptions(catalog, 'codex')).toEqual([
      { value: 'gpt-5.5', label: 'GPT 5.5' },
      { value: 'gpt-5.5-fast', label: 'GPT 5.5 Fast' },
    ])
    expect(getCatalogModelFastInfo(catalog, 'codex', 'gpt-5.5')).toEqual({
      supportsFast: true,
      isFast: false,
      baseModel: 'gpt-5.5',
      fastModel: 'gpt-5.5-fast',
    })
    expect(readCachedModelCatalog(storage)?.defaults.claude).toBe(
      'claude-fable-5'
    )
  })

  it('returns the previously fetched catalog when the network fetch fails', async () => {
    const storage = createStorage()
    await fetchModelCatalog({
      storage,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              updated_at: '2026-06-09T00:00:00Z',
              defaults: { claude: 'claude-fable-5', codex: 'gpt-5.5' },
              backends: {
                claude: {
                  models: [{ id: 'claude-fable-5', label: 'Claude Fable 5' }],
                },
                codex: { models: [{ id: 'gpt-5.5', label: 'GPT 5.5' }] },
              },
            }),
            { status: 200 }
          )
      ),
    })

    const catalog = await fetchModelCatalog({
      storage,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    expect(getCatalogModelOptions(catalog, 'claude')[0]).toEqual({
      value: 'claude-fable-5',
      label: 'Claude Fable 5',
    })
  })

  it('falls back to bundled models when neither fetch nor cache is available', async () => {
    const storage = createStorage()
    clearCachedModelCatalog(storage)

    const catalog = await fetchModelCatalog({
      storage,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    expect(getCatalogModelOptions(catalog, 'claude')).toContainEqual({
      value: 'claude-opus-4-8[1m]',
      label: 'Claude Opus 4.8 (1M)',
    })
    expect(getCatalogModelOptions(catalog, 'codex')).toContainEqual({
      value: 'gpt-5.5',
      label: 'GPT 5.5',
    })
  })
})
