import { describe, expect, it } from 'vitest'
import { fallbackUnlessWsDisconnected } from './query-fallback'

describe('fallbackUnlessWsDisconnected', () => {
  it('rethrows WebSocket disconnects so query caches keep prior data', () => {
    const error = new Error('WebSocket disconnected')

    expect(() => fallbackUnlessWsDisconnected(error, [])).toThrow(error)
  })

  it('returns the fallback for non-transport failures', () => {
    const fallback = { projects: [] }

    expect(
      fallbackUnlessWsDisconnected(new Error('invalid data'), fallback)
    ).toBe(fallback)
  })
})
