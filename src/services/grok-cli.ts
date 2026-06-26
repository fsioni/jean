/**
 * Grok Build CLI management service.
 */

import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { hasBackend } from '@/lib/environment'
import type {
  GrokAuthStatus,
  GrokCliStatus,
  GrokInstallCommand,
  GrokModelInfo,
} from '@/types/grok-cli'

const isTauri = hasBackend

export const grokCliQueryKeys = {
  all: ['grok-cli'] as const,
  status: () => [...grokCliQueryKeys.all, 'status'] as const,
  auth: () => [...grokCliQueryKeys.all, 'auth'] as const,
  models: () => [...grokCliQueryKeys.all, 'models'] as const,
  installCommand: () => [...grokCliQueryKeys.all, 'install-command'] as const,
}

export function useGrokPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...grokCliQueryKeys.all, 'path-detection'],
    queryFn: async (): Promise<{
      found: boolean
      path: string | null
      version: string | null
      packageManager: string | null
    }> => {
      if (!isTauri()) {
        return {
          found: false,
          path: null,
          version: null,
          packageManager: null,
        }
      }
      try {
        return await invoke('detect_grok_in_path')
      } catch (error) {
        logger.debug('Grok path detection failed', { error })
        return {
          found: false,
          path: null,
          version: null,
          packageManager: null,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useGrokCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: grokCliQueryKeys.status(),
    queryFn: async (): Promise<GrokCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<GrokCliStatus>('check_grok_cli_installed')
      } catch (error) {
        logger.error('Failed to check Grok CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useGrokCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: grokCliQueryKeys.auth(),
    queryFn: async (): Promise<GrokAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timedOut: false,
        }
      }
      try {
        return await invoke<GrokAuthStatus>('check_grok_cli_auth')
      } catch (error) {
        logger.error('Failed to check Grok CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
          timedOut: false,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAvailableGrokModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: grokCliQueryKeys.models(),
    queryFn: async (): Promise<GrokModelInfo[]> => {
      if (!isTauri()) {
        return [
          {
            id: 'grok-composer-2.5-fast',
            label: 'Grok Composer 2.5 Fast',
            isDefault: true,
          },
          { id: 'grok-build', label: 'Grok Build', isDefault: false },
        ]
      }
      try {
        return await invoke<GrokModelInfo[]>('list_grok_models')
      } catch (error) {
        logger.error('Failed to list Grok models', { error })
        return [
          {
            id: 'grok-composer-2.5-fast',
            label: 'Grok Composer 2.5 Fast',
            isDefault: true,
          },
          { id: 'grok-build', label: 'Grok Build', isDefault: false },
        ]
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export async function getGrokInstallCommand(): Promise<GrokInstallCommand> {
  return invoke<GrokInstallCommand>('get_grok_install_command')
}
