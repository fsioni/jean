export interface JeanWebBuildInfo {
  webBuildId: string
  appVersion: string
  gitSha?: string
  builtAt?: string
}

export const CLIENT_BUILD_INFO: JeanWebBuildInfo = __JEAN_WEB_BUILD_INFO__
export const CLIENT_WEB_BUILD_ID = CLIENT_BUILD_INFO.webBuildId
