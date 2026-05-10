// Strip ASCII C0 controls (except tab/newline/CR), DEL, and C1 controls.
// Defends against external keyboard remappers / IMEs / accessibility tools that
// inject control codepoints (e.g., U+001D Group Separator on ArrowRight).
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g

const SANITIZABLE_INPUT_TYPES = new Set([
  '',
  'email',
  'password',
  'search',
  'tel',
  'text',
  'url',
])

export function sanitizeTextInputValue(value: string): string {
  CONTROL_CHARS_RE.lastIndex = 0
  return value.replace(CONTROL_CHARS_RE, '')
}

export function listControlChars(value: string): string[] {
  const out: string[] = []
  for (const c of value) {
    const code = c.charCodeAt(0)
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      out.push(`U+${code.toString(16).padStart(4, '0').toUpperCase()}`)
    }
  }
  return out
}

export function isSanitizableTextControl(
  element: EventTarget | null
): element is HTMLInputElement | HTMLTextAreaElement {
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    )
  ) {
    return false
  }

  if (element.disabled || element.readOnly || element.closest('.xterm')) {
    return false
  }

  if (element instanceof HTMLTextAreaElement) {
    return true
  }

  return SANITIZABLE_INPUT_TYPES.has(element.type.toLowerCase())
}

function countControlCharsBefore(value: string, index: number | null): number {
  if (index === null) return 0
  return (
    value.slice(0, index).length -
    sanitizeTextInputValue(value.slice(0, index)).length
  )
}

export function sanitizeTextControlValue(
  element: HTMLInputElement | HTMLTextAreaElement
): { sanitized: boolean; removed: string[] } {
  const raw = element.value
  const value = sanitizeTextInputValue(raw)

  if (value === raw) {
    return { sanitized: false, removed: [] }
  }

  const selectionStart = element.selectionStart
  const selectionEnd = element.selectionEnd
  const startRemoved = countControlCharsBefore(raw, selectionStart)
  const endRemoved = countControlCharsBefore(raw, selectionEnd)

  element.value = value

  if (selectionStart !== null && selectionEnd !== null) {
    try {
      element.setSelectionRange(
        Math.max(0, selectionStart - startRemoved),
        Math.max(0, selectionEnd - endRemoved)
      )
    } catch {
      // Some input types do not support text selection APIs.
    }
  }

  return { sanitized: true, removed: listControlChars(raw) }
}
