import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web reconnect header indicator', () => {
  const source = readFileSync(
    `${process.cwd()}/src/components/titlebar/TitleBar.tsx`,
    'utf8'
  )

  it('renders reconnect status inside the persistent title bar', () => {
    expect(source).toContain('useWsConnectionStatus()')
    expect(source).toContain('Reconnecting…')
    expect(source).toContain('!native && !wsConnected')
  })
})
