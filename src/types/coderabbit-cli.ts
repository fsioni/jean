/** Types for CodeRabbit CLI management. */

export interface CodeRabbitCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

export interface CodeRabbitAuthStatus {
  authenticated: boolean
  error: string | null
}

export interface CodeRabbitPathDetection {
  found: boolean
  path: string | null
  version: string | null
  package_manager: string | null
}

export interface CodeRabbitReleaseInfo {
  version: string
  tagName: string
  publishedAt: string
  prerelease: boolean
}

export interface CodeRabbitInstallProgress {
  stage: 'starting' | 'downloading' | 'installing' | 'verifying' | 'complete'
  message: string
  percent: number
}
