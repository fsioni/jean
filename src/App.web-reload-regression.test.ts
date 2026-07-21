import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web reload recovery UI', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('reloads the web app after an established websocket disconnects', () => {
    expect(source).toContain(
      "logger.info('WebSocket disconnected, reloading web app')"
    )
    expect(source).toContain('onEstablishedWsDisconnect(() =>')
    expect(source).toMatch(
      /captureWebReloadState\(\)[\s\S]*?window\.location\.reload\(\)/
    )
    expect(source).toContain(
      'return <WebLoadingScreen label="Loading Jean..." />'
    )
    expect(source).not.toContain('WebReloadingOverlay')
  })
})
