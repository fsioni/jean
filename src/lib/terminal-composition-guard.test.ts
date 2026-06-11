import { beforeEach, describe, expect, it } from 'vitest'

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

  it('stops guarding after cleanup', () => {
    const cleanup = attachOrphanCompositionEndGuard(root)
    cleanup()

    dispatch('compositionend')

    expect(received).toEqual(['compositionend'])
  })
})
