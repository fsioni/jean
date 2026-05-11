/// <reference types="vite/client" />

// Tauri injects __TAURI__ into the window object when running in Tauri context
interface Window {
  __TAURI__?: Record<string, unknown>
}

interface JeanWebBuildInfo {
  webBuildId: string
  appVersion: string
  gitSha?: string
  builtAt?: string
}

declare const __JEAN_WEB_BUILD_INFO__: JeanWebBuildInfo
