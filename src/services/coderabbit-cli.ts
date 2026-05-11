/** CodeRabbit CLI management service. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { hasBackend } from '@/lib/environment'
import { invoke, listen, useWsConnectionStatus } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  CodeRabbitAuthStatus,
  CodeRabbitCliStatus,
  CodeRabbitInstallProgress,
  CodeRabbitPathDetection,
} from '@/types/coderabbit-cli'

const isTauri = hasBackend

export const coderabbitCliQueryKeys = {
  all: ['coderabbit-cli'] as const,
  status: () => [...coderabbitCliQueryKeys.all, 'status'] as const,
  auth: () => [...coderabbitCliQueryKeys.all, 'auth'] as const,
  pathDetection: () =>
    [...coderabbitCliQueryKeys.all, 'path-detection'] as const,
}

export function useCodeRabbitPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: coderabbitCliQueryKeys.pathDetection(),
    queryFn: async (): Promise<CodeRabbitPathDetection> => {
      if (!isTauri()) {
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
      try {
        return invoke<CodeRabbitPathDetection>('detect_coderabbit_in_path')
      } catch (error) {
        logger.debug('CodeRabbit PATH detection failed', { error })
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useCodeRabbitCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: coderabbitCliQueryKeys.status(),
    queryFn: async (): Promise<CodeRabbitCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return invoke<CodeRabbitCliStatus>('check_coderabbit_cli_installed')
      } catch (error) {
        logger.error('Failed to check CodeRabbit CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useCodeRabbitCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: coderabbitCliQueryKeys.auth(),
    queryFn: async (): Promise<CodeRabbitAuthStatus> => {
      if (!isTauri())
        return { authenticated: false, error: 'Not in Tauri context' }
      try {
        return invoke<CodeRabbitAuthStatus>('check_coderabbit_cli_auth')
      } catch (error) {
        logger.error('Failed to check CodeRabbit CLI auth', { error })
        return { authenticated: false, error: String(error) }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useInstallCodeRabbitCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await invoke('install_coderabbit_cli')
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: coderabbitCliQueryKeys.all })
      toast.success('CodeRabbit CLI installed successfully')
    },
    onError: error => {
      logger.error('Failed to install CodeRabbit CLI', { error })
      toast.error('Failed to install CodeRabbit CLI', {
        description: String(error),
      })
    },
  })
}

export function useUpdateCodeRabbitCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await invoke('update_coderabbit_cli')
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: coderabbitCliQueryKeys.all })
      toast.success('CodeRabbit CLI updated')
    },
    onError: error => {
      logger.error('Failed to update CodeRabbit CLI', { error })
      toast.error('Failed to update CodeRabbit CLI', {
        description: String(error),
      })
    },
  })
}

export function useCodeRabbitInstallProgress(): [
  CodeRabbitInstallProgress | null,
  () => void,
] {
  const [progress, setProgress] = useState<CodeRabbitInstallProgress | null>(
    null
  )
  const wsConnected = useWsConnectionStatus()
  const resetProgress = useCallback(() => setProgress(null), [])

  useEffect(() => {
    if (!isTauri()) return
    let unlistenFn: (() => void) | null = null
    const setup = async () => {
      unlistenFn = await listen<CodeRabbitInstallProgress>(
        'coderabbit-cli:install-progress',
        event => setProgress(event.payload)
      )
    }
    setup().catch(error =>
      logger.error('Failed to listen for CodeRabbit install progress', {
        error,
      })
    )
    return () => unlistenFn?.()
  }, [wsConnected])

  return [progress, resetProgress]
}
