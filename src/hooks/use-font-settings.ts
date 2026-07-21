import { useEffect } from 'react'
import { usePreferences } from '@/services/preferences'
import type { UIFont, ChatFont } from '@/types/preferences'
import { FONT_SIZE_DEFAULT } from '@/types/preferences'

// Calculate line height based on font size
function getLineHeight(fontSize: number): string {
  // Larger fonts need slightly less line height for visual balance
  if (fontSize <= 12) return '1.5'
  if (fontSize <= 14) return '1.55'
  if (fontSize <= 16) return '1.6'
  if (fontSize <= 18) return '1.65'
  return '1.7'
}

// Validate font size, return default if invalid
function validateFontSize(size: number | undefined): number {
  if (typeof size !== 'number' || isNaN(size) || size <= 0)
    return FONT_SIZE_DEFAULT
  return size
}

function pxToRem(size: number): string {
  return `${size / 16}rem`
}

const uiFontFamilyMap: Record<UIFont, string> = {
  inter: "'Inter', -apple-system, 'Segoe UI', 'Roboto', sans-serif",
  geist: "'Geist', -apple-system, 'Segoe UI', 'Roboto', sans-serif",
  roboto: "'Roboto', -apple-system, 'Segoe UI', sans-serif",
  lato: "'Lato', -apple-system, 'Segoe UI', sans-serif",
  system: "-apple-system, 'Segoe UI', 'Roboto', sans-serif",
}

const chatFontFamilyMap: Record<ChatFont, string> = {
  'jetbrains-mono':
    "'JetBrains Mono', ui-monospace, 'SF Mono', 'Menlo', monospace",
  'fira-code': "'Fira Code', ui-monospace, 'SF Mono', 'Menlo', monospace",
  'source-code-pro':
    "'Source Code Pro', ui-monospace, 'SF Mono', 'Menlo', monospace",
  inter: "'Inter', -apple-system, 'Segoe UI', 'Roboto', sans-serif",
  geist: "'Geist', -apple-system, 'Segoe UI', 'Roboto', sans-serif",
  roboto: "'Roboto', -apple-system, 'Segoe UI', sans-serif",
  lato: "'Lato', -apple-system, 'Segoe UI', sans-serif",
}

function applyFontSettings(
  uiFontSize?: number,
  chatFontSize?: number,
  uiFont?: string,
  chatFont?: string
) {
  const validUiSize = validateFontSize(uiFontSize)
  const validChatSize = validateFontSize(chatFontSize)
  const uiFontFamily = (uiFont ?? 'inter') as UIFont
  const chatFontFamily = (chatFont ?? 'jetbrains-mono') as ChatFont

  const validUiFont = uiFontFamilyMap[uiFontFamily] ? uiFontFamily : 'inter'
  const validChatFont = chatFontFamilyMap[chatFontFamily]
    ? chatFontFamily
    : 'jetbrains-mono'

  const root = document.documentElement
  root.style.setProperty('--ui-font-size', pxToRem(validUiSize))
  root.style.setProperty('--ui-line-height', getLineHeight(validUiSize))
  root.style.setProperty('--chat-font-size', pxToRem(validChatSize))
  root.style.setProperty('--chat-line-height', getLineHeight(validChatSize))
  root.style.setProperty('--font-family-sans', uiFontFamilyMap[validUiFont])
  root.style.setProperty('--font-family-chat', chatFontFamilyMap[validChatFont])
}

export function useFontSettings() {
  const { data: preferences } = usePreferences()

  // Apply on mount with defaults
  useEffect(() => {
    applyFontSettings()
  }, [])

  // Apply when preferences change
  useEffect(() => {
    if (preferences) {
      applyFontSettings(
        preferences.ui_font_size,
        preferences.chat_font_size,
        preferences.ui_font,
        preferences.chat_font
      )
    }
  }, [preferences])
}
