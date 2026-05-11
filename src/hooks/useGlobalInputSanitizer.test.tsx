import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGlobalInputSanitizer } from './useGlobalInputSanitizer'

describe('useGlobalInputSanitizer', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('sanitizes input before target handlers consume the value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    renderHook(() => useGlobalInputSanitizer())

    const input = document.createElement('input')
    input.type = 'text'
    document.body.appendChild(input)

    let observedValue = ''
    input.addEventListener('input', () => {
      observedValue = input.value
    })

    input.value = 'abc\x1Ddef'
    input.setSelectionRange(input.value.length, input.value.length)
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(observedValue).toBe('abcdef')
    expect(input.value).toBe('abcdef')
    expect(input.selectionStart).toBe(6)
  })

  it('sanitizes textareas app-wide', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    renderHook(() => useGlobalInputSanitizer())

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    textarea.value = 'line 1\x1D\nline 2'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))

    expect(textarea.value).toBe('line 1\nline 2')
  })

  it('does not sanitize terminal textarea input', () => {
    renderHook(() => useGlobalInputSanitizer())

    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const textarea = document.createElement('textarea')
    terminal.appendChild(textarea)
    document.body.appendChild(terminal)

    textarea.value = '\x1B[C'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))

    expect(textarea.value).toBe('\x1B[C')
  })
})
