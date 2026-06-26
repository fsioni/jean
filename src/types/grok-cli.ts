/**
 * Types for Grok Build CLI management.
 */

export interface GrokCliStatus {
  installed: boolean
  version: string | null
  path: string | null
}

export interface GrokAuthStatus {
  authenticated: boolean
  error: string | null
  timedOut?: boolean
}

export interface GrokModelInfo {
  id: string
  label: string
  isDefault?: boolean
}

export interface GrokInstallCommand {
  command: string
  args: string[]
  description: string
}
