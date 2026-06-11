import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachOrphanCompositionEndGuard } from './terminal-composition-guard'

/**
 * Regression: WebKitGTK (Tauri Linux webview) + ibus commits composed
 * characters (é, ç on AZERTY) by firing `compositionend` WITHOUT a preceding
 * `compositionstart`. xterm.js's CompositionHelper assumes balanced pairs:
 * an orphan `compositionend` makes it re-send the hidden textarea's
 * accumulated content on every keystroke (é → éé → ééé…).
 *
 * The guard sits in the capture phase on the terminal host element (an
 * ancestor of xterm's textarea) and swallows orphan `compositionend` events
 * before they reach xterm's own listeners. Balanced sequences (real IME
 * input) must pass through untouched.
 */
describe('attachOrphanCompositionEndGuard', () => {
  let root: HTMLDivElement
  let textarea: HTMLTextAreaElement
  let received: string[]

  const dispatch = (type: string) => {
    textarea.dispatchEvent(new Event(type, { bubbles: true }))
  }

  beforeEach(() => {
    root = document.createElement('div')
    textarea = document.createElement('textarea')
    root.appendChild(textarea)
    document.body.replaceChildren(root)
    received = []
    // Mimic xterm.js: composition listeners registered on the textarea.
    for (const type of ['compositionstart', 'compositionend']) {
      textarea.addEventListener(type, () => received.push(type))
    }
  })

  it('swallows a compositionend that has no matching compositionstart', () => {
    attachOrphanCompositionEndGuard(root)

    dispatch('compositionend')

    expect(received).toEqual([])
  })

  it('lets balanced compositionstart/compositionend pairs through', () => {
    attachOrphanCompositionEndGuard(root)

    dispatch('compositionstart')
    dispatch('compositionend')

    expect(received).toEqual(['compositionstart', 'compositionend'])
  })

  it('swallows an orphan end following a balanced pair', () => {
    attachOrphanCompositionEndGuard(root)

    dispatch('compositionstart')
    dispatch('compositionend')
    dispatch('compositionend') // WebKitGTK orphan commit right after real IME

    expect(received).toEqual(['compositionstart', 'compositionend'])
  })

  it('handles repeated orphan commits (the é → éé → ééé scenario)', () => {
    attachOrphanCompositionEndGuard(root)

    dispatch('compositionend')
    dispatch('compositionend')
    dispatch('compositionend')

    expect(received).toEqual([])
  })

  it('swallows an end whose target differs from the open composition', () => {
    // A compositionstart on a sibling element must not "balance" a
    // compositionend fired by xterm's textarea (the orphan path).
    const sibling = document.createElement('input')
    root.appendChild(sibling)
    attachOrphanCompositionEndGuard(root)

    sibling.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    dispatch('compositionend') // fired by textarea, not the sibling

    expect(received).toEqual([])
  })

  it('stops guarding after cleanup', () => {
    const cleanup = attachOrphanCompositionEndGuard(root)
    cleanup()

    dispatch('compositionend')

    expect(received).toEqual(['compositionend'])
  })
})

/**
 * Regression for the residual intermittent duplication left after the orphan
 * `compositionend` swallow landed.
 *
 * With orphan ends swallowed, a composed char's ONLY delivery path is xterm's
 * `CompositionHelper._handleAnyTextareaChanges`: snapshot `textarea.value` on
 * keydown(229), send the diff in a `setTimeout(0)`. ibus is asynchronous, so
 * the keydown/input/compositionend triplets of consecutive keystrokes can
 * arrive in one burst (DBus latency, main-thread jank) before any timer runs:
 *
 *   kd1 snap "" → in1 "é" → kd2 snap "é" → in2 "éé"
 *   → timer1 diff "éé", timer2 diff "é"  ⇒ "ééé" for two keystrokes.
 *
 * Fix: when `deliverOrphanData` is provided, the guard takes over delivery at
 * the `input` event (`insertFromComposition` outside any composition): it
 * strips the committed text from the textarea and delivers it exactly once,
 * so xterm's racy diff never sees composed chars at all.
 */
describe('attachOrphanCompositionEndGuard — orphan commit delivery', () => {
  let root: HTMLDivElement
  let textarea: HTMLTextAreaElement
  let delivered: string[]
  let diffSent: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    root = document.createElement('div')
    textarea = document.createElement('textarea')
    root.appendChild(textarea)
    document.body.replaceChildren(root)
    delivered = []
    diffSent = []
    // Faithful mimic of xterm's CompositionHelper._handleAnyTextareaChanges
    // (the keydown-229 path): snapshot on keydown, send the diff at t+0.
    textarea.addEventListener('keydown', () => {
      const oldValue = textarea.value
      setTimeout(() => {
        const newValue = textarea.value
        const diff = newValue.replace(oldValue, '')
        if (newValue.length > oldValue.length) {
          diffSent.push(diff)
        }
      }, 0)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const deliver = (data: string) => delivered.push(data)

  // One WebKitGTK+ibus composed keystroke: keydown(229) + UA insertion +
  // `input insertFromComposition` + orphan `compositionend`.
  const commitComposedChar = (char: string) => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
    textarea.value += char
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: char,
        inputType: 'insertFromComposition',
      })
    )
    textarea.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: char })
    )
  }

  it('delivers each composed char exactly once when keystrokes arrive in one burst (é → ééé regression)', () => {
    attachOrphanCompositionEndGuard(root, deliver)

    // Burst: the second keystroke is dispatched before the first diff timer.
    commitComposedChar('é')
    commitComposedChar('é')
    vi.runAllTimers()

    expect(delivered).toEqual(['é', 'é'])
    expect(diffSent).toEqual([])
    expect(textarea.value).toBe('')
  })

  it('delivers the char even when the diff timer fires before the async ibus commit', () => {
    attachOrphanCompositionEndGuard(root, deliver)

    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
    vi.runAllTimers() // xterm's diff fires while the commit is still in flight
    textarea.value += 'é'
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: 'é',
        inputType: 'insertFromComposition',
      })
    )
    textarea.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: 'é' })
    )
    vi.runAllTimers()

    expect(delivered).toEqual(['é'])
    expect(diffSent).toEqual([])
  })

  it('leaves commits of a real (balanced) composition to xterm', () => {
    attachOrphanCompositionEndGuard(root, deliver)

    textarea.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true })
    )
    textarea.value += 'ふ'
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: 'ふ',
        inputType: 'insertFromComposition',
      })
    )

    expect(delivered).toEqual([])
    expect(textarea.value).toBe('ふ')
  })

  it('ignores non-composition input events (insertText keeps the xterm diff path)', () => {
    attachOrphanCompositionEndGuard(root, deliver)

    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
    textarea.value += '2'
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '2',
        inputType: 'insertText',
      })
    )
    vi.runAllTimers()

    expect(delivered).toEqual([])
    expect(diffSent).toEqual(['2'])
    expect(textarea.value).toBe('2')
  })

  it('falls back to swallow-only when the committed data is not the textarea suffix', () => {
    attachOrphanCompositionEndGuard(root, deliver)

    textarea.value = 'xy'
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: 'é',
        inputType: 'insertFromComposition',
      })
    )

    expect(delivered).toEqual([])
    expect(textarea.value).toBe('xy')
  })

  it('keeps the legacy swallow-only behavior when no delivery callback is given', () => {
    attachOrphanCompositionEndGuard(root)

    commitComposedChar('é')
    vi.runAllTimers()

    expect(diffSent).toEqual(['é'])
    expect(textarea.value).toBe('é')
  })

  it('stops delivering after cleanup', () => {
    const cleanup = attachOrphanCompositionEndGuard(root, deliver)
    cleanup()

    textarea.value += 'é'
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: 'é',
        inputType: 'insertFromComposition',
      })
    )

    expect(delivered).toEqual([])
    expect(textarea.value).toBe('é')
  })
})
