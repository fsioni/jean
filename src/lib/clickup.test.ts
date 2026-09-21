import { describe, expect, it } from 'vitest'
import { clickUpTaskIdFromBranch, clickupTaskUrl } from './clickup'

describe('clickUpTaskIdFromBranch', () => {
  it.each([
    ['CU-86caa8btx-fix-contrat-readonly', '86caa8btx'],
    ['CU-86caa8btx', '86caa8btx'],
    ['CU-86c997enp__national-id', '86c997enp'],
    ['cu-abc123-something', 'abc123'],
  ])('extracts the task id from %s', (branch, expected) => {
    expect(clickUpTaskIdFromBranch(branch)).toBe(expected)
  })

  it.each([
    ['feature-without-ticket'],
    ['CU--desc'],
    [''],
    [null],
    [undefined],
  ])('returns null for %s', branch => {
    expect(clickUpTaskIdFromBranch(branch)).toBeNull()
  })
})

describe('clickupTaskUrl', () => {
  it('builds the task URL', () => {
    expect(clickupTaskUrl('86caa8btx')).toBe(
      'https://app.clickup.com/t/86caa8btx'
    )
  })
})
