import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web reconnect UI', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('keeps the cached app visible without a blocking reconnect overlay', () => {
    expect(source).toContain('<MainWindow />')
    expect(source).not.toContain('<WsReconnectOverlay />')
    expect(source).not.toContain('<WsReconnectBanner />')
  })
})
