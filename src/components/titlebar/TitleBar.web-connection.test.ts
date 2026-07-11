import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web connection header indicator', () => {
  const source = readFileSync(
    `${process.cwd()}/src/components/titlebar/TitleBar.tsx`,
    'utf8'
  )

  it('renders reconnecting status while the web socket opens', () => {
    expect(source).toContain('useWsConnectionStatus()')
    expect(source).not.toContain('useWsDataReady()')
    expect(source).toContain('Reconnecting…')
    expect(source).toContain('!native && !wsConnected')
    expect(source).toContain('text-sm font-medium text-yellow-400')
    expect(source).toContain(
      '<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />'
    )
  })
})
