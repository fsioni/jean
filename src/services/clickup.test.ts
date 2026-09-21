import { describe, expect, it } from 'vitest'
import { clickupQueryKeys, isClickUpAuthError } from './clickup'

describe('isClickUpAuthError', () => {
  it('detects the missing-token error', () => {
    expect(
      isClickUpAuthError(new Error('No ClickUp API token configured.'))
    ).toBe(true)
  })

  it('detects the invalid-token error', () => {
    expect(
      isClickUpAuthError('ClickUp API token is invalid. Update it in Settings.')
    ).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isClickUpAuthError(new Error('Network unreachable'))).toBe(false)
    expect(isClickUpAuthError(null)).toBe(false)
    expect(isClickUpAuthError(undefined)).toBe(false)
  })
})

describe('clickupQueryKeys', () => {
  it('namespaces all keys under "clickup"', () => {
    expect(clickupQueryKeys.config()[0]).toBe('clickup')
    expect(clickupQueryKeys.task('86abc')).toEqual(['clickup', 'task', '86abc'])
    expect(clickupQueryKeys.resolvedTask('wt-1')).toEqual([
      'clickup',
      'resolved-task',
      'wt-1',
    ])
  })

  it('produces distinct keys per task id', () => {
    expect(clickupQueryKeys.task('a')).not.toEqual(clickupQueryKeys.task('b'))
  })
})
