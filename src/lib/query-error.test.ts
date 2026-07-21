import { describe, expect, it } from 'vitest'
import { preserveQueryCacheOnError } from './query-error'

describe('preserveQueryCacheOnError', () => {
  it('rethrows WebSocket disconnects so query caches keep prior data', () => {
    const error = new Error('WebSocket disconnected')

    expect(() => preserveQueryCacheOnError(error)).toThrow(error)
  })

  it('rethrows command timeouts caused by iOS background suspension', () => {
    const error = new Error("Command 'list_projects' timed out after 60s")

    expect(() => preserveQueryCacheOnError(error)).toThrow(error)
  })

  it('rethrows every query failure instead of replacing cached data', () => {
    const error = new Error('invalid session data')

    expect(() => preserveQueryCacheOnError(error)).toThrow(error)
  })
})
