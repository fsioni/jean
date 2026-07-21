import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockPreferences:
  | {
      ui_font_size?: number
      chat_font_size?: number
      ui_font?: string
      chat_font?: string
    }
  | undefined

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mockPreferences }),
}))

import { useFontSettings } from './use-font-settings'

describe('useFontSettings', () => {
  beforeEach(() => {
    mockPreferences = {
      ui_font_size: 14,
      chat_font_size: 18,
      ui_font: 'geist',
      chat_font: 'inter',
    }
    document.documentElement.style.removeProperty('--ui-font-size')
    document.documentElement.style.removeProperty('--chat-font-size')
  })

  afterEach(() => {
    document.documentElement.style.removeProperty('--ui-font-size')
    document.documentElement.style.removeProperty('--chat-font-size')
  })

  it('stores app font sizes in rem so web zoom can reflow layout', async () => {
    renderHook(() => useFontSettings())

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue('--ui-font-size')
      ).toBe('0.875rem')
    })
    expect(
      document.documentElement.style.getPropertyValue('--chat-font-size')
    ).toBe('1.125rem')
  })
})
