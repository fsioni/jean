import { describe, expect, it } from 'vitest'
import { resolveDefaultTabUrl } from './default-tab-url'

describe('resolveDefaultTabUrl', () => {
  it('defaults configured ports to localhost', () => {
    expect(resolveDefaultTabUrl([{ port: 8000, label: 'App' }])).toBe(
      'http://localhost:8000'
    )
  })

  it('uses a configured host when present', () => {
    expect(
      resolveDefaultTabUrl([{ port: 8000, label: 'App', host: '192.168.1.42' }])
    ).toBe('http://192.168.1.42:8000')
  })
})
