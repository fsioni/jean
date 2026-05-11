import { afterEach, describe, expect, it } from 'vitest'
import {
  isSanitizableTextControl,
  listControlChars,
  sanitizeTextControlValue,
  sanitizeTextInputValue,
} from './input-sanitization'

describe('input sanitization', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('strips control chars but preserves tabs and line endings', () => {
    expect(sanitizeTextInputValue('a\x1Db\x00c\x7Fd\u0085e')).toBe('abcde')
    expect(sanitizeTextInputValue('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  it('lists stripped control codepoints', () => {
    expect(listControlChars('a\x1D\x00\x7F\u0085b')).toEqual([
      'U+001D',
      'U+0000',
      'U+007F',
      'U+0085',
    ])
  })

  it('sanitizes a text control value and preserves cursor position', () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = 'ab\x1Dcd\x00ef'
    input.setSelectionRange(6, 6)

    const result = sanitizeTextControlValue(input)

    expect(result.sanitized).toBe(true)
    expect(input.value).toBe('abcdef')
    expect(input.selectionStart).toBe(4)
    expect(input.selectionEnd).toBe(4)
  })

  it('detects sanitizable textarea and text-like input controls', () => {
    const input = document.createElement('input')
    const email = document.createElement('input')
    email.type = 'email'
    const textarea = document.createElement('textarea')

    expect(isSanitizableTextControl(input)).toBe(true)
    expect(isSanitizableTextControl(email)).toBe(true)
    expect(isSanitizableTextControl(textarea)).toBe(true)
  })

  it('skips terminal and non-text inputs', () => {
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const terminalInput = document.createElement('textarea')
    terminal.appendChild(terminalInput)
    document.body.appendChild(terminal)

    const fileInput = document.createElement('input')
    fileInput.type = 'file'

    expect(isSanitizableTextControl(terminalInput)).toBe(false)
    expect(isSanitizableTextControl(fileInput)).toBe(false)
  })

  it('skips disabled and read-only controls', () => {
    const disabled = document.createElement('input')
    disabled.disabled = true
    const readOnly = document.createElement('textarea')
    readOnly.readOnly = true

    expect(isSanitizableTextControl(disabled)).toBe(false)
    expect(isSanitizableTextControl(readOnly)).toBe(false)
  })
})
