import { describe, expect, it } from 'vitest'

import { getCanvasStatusRefreshMs } from './canvas-status-refresh'

describe('getCanvasStatusRefreshMs', () => {
  it('uses 60 seconds when no preference is available', () => {
    expect(getCanvasStatusRefreshMs()).toBe(60_000)
  })

  it('does not refresh more often than once per minute', () => {
    expect(getCanvasStatusRefreshMs(30)).toBe(60_000)
  })

  it('uses slower user-configured git polling intervals', () => {
    expect(getCanvasStatusRefreshMs(300)).toBe(300_000)
  })
})
