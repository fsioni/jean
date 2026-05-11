import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke as transportInvoke } from '@/lib/transport'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { setWsConnected } from '@/lib/environment'
import { useCliVersionCheck } from './useCliVersionCheck'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}))

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      auto_update_ai_backends: true,
      claude_cli_source: 'jean',
      codex_cli_source: 'jean',
      opencode_cli_source: 'path',
      gh_cli_source: 'jean',
    },
    isLoading: false,
  }),
}))

vi.mock('@/services/claude-cli', () => ({
  claudeCliQueryKeys: { all: ['claude-cli'] },
  useClaudeCliStatus: () => ({
    data: { installed: false, version: null, path: null },
    isLoading: false,
  }),
  useAvailableCliVersions: () => ({ data: [], isLoading: false }),
  useClaudePathDetection: () => ({
    data: { found: false, version: null, path: null, package_manager: null },
  }),
}))

vi.mock('@/services/gh-cli', () => ({
  ghCliQueryKeys: { all: ['gh-cli'] },
  useGhCliStatus: () => ({
    data: { installed: false, version: null, path: null },
    isLoading: false,
  }),
  useAvailableGhVersions: () => ({ data: [], isLoading: false }),
  useGhPathDetection: () => ({
    data: { found: false, version: null, path: null, package_manager: null },
  }),
}))

vi.mock('@/services/codex-cli', () => ({
  codexCliQueryKeys: { all: ['codex-cli'] },
  useCodexCliStatus: () => ({
    data: { installed: false, version: null, path: null },
    isLoading: false,
  }),
  useAvailableCodexVersions: () => ({ data: [], isLoading: false }),
  useCodexPathDetection: () => ({
    data: { found: false, version: null, path: null, package_manager: null },
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  opencodeCliQueryKeys: { all: ['opencode-cli'] },
  useOpencodeCliStatus: () => ({
    data: { installed: true, version: '1.0.0', path: '/usr/bin/opencode' },
    isLoading: false,
  }),
  useAvailableOpencodeVersions: () => ({
    data: [{ version: '1.1.0', prerelease: false }],
    isLoading: false,
  }),
  useOpencodePathDetection: () => ({
    data: {
      found: true,
      version: '1.0.0',
      path: '/usr/bin/opencode',
      package_manager: null,
    },
  }),
}))

describe('useCliVersionCheck', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    setWsConnected(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    queryClient.clear()
    setWsConnected(false)
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
  })

  it('runs mobile-safe CLI updates through the shared transport invoke', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useCliVersionCheck(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await Promise.resolve()

    expect(transportInvoke).toHaveBeenCalledWith('run_cli_path_update', {
      command: '/usr/bin/opencode',
      args: ['upgrade'],
      cliType: 'opencode',
    })
    expect(tauriInvoke).not.toHaveBeenCalled()
  })
})
