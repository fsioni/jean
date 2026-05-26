import type { AppPreferences } from '@/types/preferences'

const LIGHT_BG = '#fafafa'
const DARK_BG = '#101010'
const LIGHT_FG = '#101010'
const DARK_FG = '#fafafa'
const LIGHT_SEL = '#e5e5e5'
const DARK_SEL = '#242424'

/**
 * The 16 ANSI color slots xterm exposes on its theme. Provided per-palette so a
 * light terminal background does not render bright/white ANSI colors invisibly.
 */
interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

// Tuned for a dark background (close to xterm defaults).
const DARK_ANSI: AnsiPalette = {
  black: '#1a1a1a',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d4d4',
  brightBlack: '#6b7280',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
}

// Tuned for a light background — "white" slots become dark grays so text on a
// light terminal stays legible.
const LIGHT_ANSI: AnsiPalette = {
  black: '#1a1a1a',
  red: '#c0392b',
  green: '#2d7a2d',
  yellow: '#b8860b',
  blue: '#2563c0',
  magenta: '#9b3b9b',
  cyan: '#1a8a8a',
  white: '#595959',
  brightBlack: '#6b6b6b',
  brightRed: '#e74c3c',
  brightGreen: '#38a338',
  brightYellow: '#c2900f',
  brightBlue: '#3b82e0',
  brightMagenta: '#b94ab9',
  brightCyan: '#1f9f9f',
  brightWhite: '#2a2a2a',
}

export interface ResolvedTerminalTheme extends Partial<AnsiPalette> {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  selectionForeground?: string
}

export function isValidHex(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false
  return /^#[0-9a-f]{6}$/i.test(value.trim())
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m || !m[1]) return 0
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  const lin = (x: number) =>
    x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function isLight(bgHex: string): boolean {
  return luminance(bgHex) > 0.5
}

export function pickReadableFg(bgHex: string): string {
  return isLight(bgHex) ? LIGHT_FG : DARK_FG
}

export function resolveTerminalTheme(
  prefs: Pick<
    AppPreferences,
    'terminal_background' | 'terminal_background_custom'
  >,
  fallbackFromCss: () => ResolvedTerminalTheme
): ResolvedTerminalTheme {
  switch (prefs.terminal_background) {
    case 'light':
      return {
        background: LIGHT_BG,
        foreground: LIGHT_FG,
        cursor: LIGHT_FG,
        selectionBackground: LIGHT_SEL,
        ...LIGHT_ANSI,
      }
    case 'dark':
      return {
        background: DARK_BG,
        foreground: DARK_FG,
        cursor: DARK_FG,
        selectionBackground: DARK_SEL,
        ...DARK_ANSI,
      }
    case 'custom': {
      const bg = isValidHex(prefs.terminal_background_custom)
        ? prefs.terminal_background_custom
        : DARK_BG
      const light = isLight(bg)
      const fg = light ? LIGHT_FG : DARK_FG
      return {
        background: bg,
        foreground: fg,
        cursor: fg,
        selectionBackground: light ? LIGHT_SEL : DARK_SEL,
        ...(light ? LIGHT_ANSI : DARK_ANSI),
      }
    }
    case 'auto':
    default:
      return fallbackFromCss()
  }
}
