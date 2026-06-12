import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachOrphanCompositionEndGuard } from './terminal-composition-guard'

const NBSP = ' '
const DEL = '\x7f'

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
 * Regression for the corruption left after the orphan `compositionend`
 * swallow landed, root-caused from live WebKitGTK traces:
 *
 * 1. WebKitGTK routes committed text through the input method, so the UA
 *    inserts it into xterm's hidden textarea even though xterm called
 *    preventDefault() on the keydown. Every typed space / shifted letter
 *    accumulates there forever (xterm only clears on Enter/^C/blur).
 * 2. xterm's `CompositionHelper._handleAnyTextareaChanges` (scheduled on
 *    every keydown 229) compares a keydown-time snapshot with the value in a
 *    setTimeout(0):
 *      - grew      → sends the diff        (the original é → éé bug)
 *      - shrank    → sends DEL             (erases the just-typed char)
 *      - same length but different content → SENDS THE WHOLE TEXTAREA
 *    WebKit's editing layer normalizes a trailing NBSP to a plain space when
 *    committing a composed char right after it, which triggers that third
 *    branch and flushes the accumulated junk to the PTY.
 *
 * Fix: when `deliverOrphanData` is provided the guard snapshots the textarea
 * value on `beforeinput` and restores it verbatim on `input`, both for orphan
 * `insertFromComposition` commits (delivered exactly once via the callback)
 * and for `insertText` echoes of keys xterm already delivered directly (last
 * keydown ≠ 229). The diff timer then always sees oldValue === newValue and
 * none of its branches can fire.
 */
describe('attachOrphanCompositionEndGuard — textarea hygiene & delivery', () => {
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
    // Faithful mimic of xterm's CompositionHelper._handleAnyTextareaChanges:
    // scheduled on keydown(229) only, all three branches included.
    textarea.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).keyCode !== 229) {
        return
      }
      const oldValue = textarea.value
      setTimeout(() => {
        const newValue = textarea.value
        const diff = newValue.replace(oldValue, '')
        if (newValue.length > oldValue.length) {
          diffSent.push(diff)
        } else if (newValue.length < oldValue.length) {
          diffSent.push(DEL)
        } else if (newValue !== oldValue) {
          diffSent.push(newValue)
        }
      }, 0)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const deliver = (data: string) => delivered.push(data)

  const keydown = (keyCode: number) => {
    const event = new KeyboardEvent('keydown', { bubbles: true })
    Object.defineProperty(event, 'keyCode', { value: keyCode })
    textarea.dispatchEvent(event)
  }

  const fireInput = (
    type: 'beforeinput' | 'input',
    inputType: string,
    data: string
  ) => {
    textarea.dispatchEvent(
      new InputEvent(type, { bubbles: true, data, inputType })
    )
  }

  // One WebKitGTK+ibus composed keystroke: keydown(229), beforeinput, UA
  // insertion, input, orphan compositionend. `mutate` reproduces how the UA
  // actually changed the value (append by default).
  const commitComposedChar = (
    char: string,
    mutate: () => void = () => {
      textarea.value += char
    }
  ) => {
    keydown(229)
    fireInput('beforeinput', 'insertFromComposition', char)
    mutate()
    fireInput('input', 'insertFromComposition', char)
    textarea.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: char })
    )
  }

  // One ordinary keystroke whose key xterm already delivered directly on
  // keydown; WebKitGTK's IM still echoes it into the textarea afterwards.
  const echoDirectKey = (keyCode: number, data: string, inserted = data) => {
    keydown(keyCode)
    fireInput('beforeinput', 'insertText', data)
    textarea.value += inserted
    fireInput('input', 'insertText', data)
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

    keydown(229)
    vi.runAllTimers() // xterm's diff fires while the commit is still in flight
    fireInput('beforeinput', 'insertFromComposition', 'é')
    textarea.value += 'é'
    fireInput('input', 'insertFromComposition', 'é')
    textarea.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: 'é' })
    )
    vi.runAllTimers()

    expect(delivered).toEqual(['é'])
    expect(diffSent).toEqual([])
  })

  it('restores the textarea when WebKit normalizes a trailing NBSP during the commit (junk-burst regression)', () => {
    // Trace-proven: value [NBSP, NBSP] + é commit → WebKit rewrites it to
    // [NBSP, " ", é]. After a suffix-strip the value has the same length but
    // different content than the keydown snapshot, and xterm's third diff
    // branch sends the ENTIRE textarea to the PTY.
    attachOrphanCompositionEndGuard(root, deliver)

    textarea.value = `${NBSP}${NBSP}`
    commitComposedChar('é', () => {
      textarea.value = `${NBSP} é`
    })
    vi.runAllTimers()

    expect(delivered).toEqual(['é'])
    expect(diffSent).toEqual([])
    expect(textarea.value).toBe(`${NBSP}${NBSP}`)
  })

  it('restores the textarea when the commit replaces a char instead of appending (DEL regression)', () => {
    // Trace-proven: a stale WebKit composition range can make the commit
    // REPLACE the last char. The value shrinks after delivery and xterm's
    // diff branch then sends DEL, erasing the just-typed accent.
    attachOrphanCompositionEndGuard(root, deliver)

    textarea.value = '    '
    commitComposedChar('é', () => {
      textarea.value = '   é'
    })
    vi.runAllTimers()

    expect(delivered).toEqual(['é'])
    expect(diffSent).toEqual([])
    expect(textarea.value).toBe('    ')
  })

  it('drains insertText echoes of keys xterm already delivered directly (space accumulation regression)', () => {
    // Trace-proven: WebKitGTK inserts every typed space/shifted letter into
    // the hidden textarea despite xterm's preventDefault. The echo sometimes
    // inserts NBSP while event.data says " ", so the guard restores the
    // beforeinput snapshot instead of matching the data suffix.
    attachOrphanCompositionEndGuard(root, deliver)

    echoDirectKey(32, ' ', NBSP)
    echoDirectKey(77, 'M')
    echoDirectKey(32, ' ', NBSP)
    vi.runAllTimers()

    expect(delivered).toEqual([])
    expect(diffSent).toEqual([])
    expect(textarea.value).toBe('')
  })

  it('keeps insertText after keydown(229) on the xterm diff path (IME-active punctuation)', () => {
    // A digit/punctuation key pressed while an IME is active arrives as
    // keydown(229) + insertText; xterm delivers it via the grow-diff. The
    // guard must not drain it, or the char would be lost.
    attachOrphanCompositionEndGuard(root, deliver)

    keydown(229)
    fireInput('beforeinput', 'insertText', '2')
    textarea.value += '2'
    fireInput('input', 'insertText', '2')
    vi.runAllTimers()

    expect(delivered).toEqual([])
    expect(diffSent).toEqual(['2'])
    expect(textarea.value).toBe('2')
  })

  it('leaves keydown-less insertText alone (emoji picker / dictation)', () => {
    attachOrphanCompositionEndGuard(root, deliver)

    fireInput('beforeinput', 'insertText', '🎉')
    textarea.value += '🎉'
    fireInput('input', 'insertText', '🎉')
    vi.runAllTimers()

    expect(delivered).toEqual([])
    expect(textarea.value).toBe('🎉')
  })

  it('leaves commits of a real (balanced) composition to xterm', () => {
    attachOrphanCompositionEndGuard(root, deliver)

    textarea.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true })
    )
    fireInput('beforeinput', 'insertFromComposition', 'ふ')
    textarea.value += 'ふ'
    fireInput('input', 'insertFromComposition', 'ふ')

    expect(delivered).toEqual([])
    expect(textarea.value).toBe('ふ')
  })

  it('does not drain insertText while a composition is open', () => {
    attachOrphanCompositionEndGuard(root, deliver)

    textarea.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true })
    )
    keydown(65)
    fireInput('beforeinput', 'insertText', 'あ')
    textarea.value += 'あ'
    fireInput('input', 'insertText', 'あ')

    expect(delivered).toEqual([])
    expect(textarea.value).toBe('あ')
  })

  it('keeps the legacy swallow-only behavior when no delivery callback is given', () => {
    attachOrphanCompositionEndGuard(root)

    commitComposedChar('é')
    vi.runAllTimers()

    expect(diffSent).toEqual(['é'])
    expect(textarea.value).toBe('é')
  })

  it('stops delivering and draining after cleanup', () => {
    const cleanup = attachOrphanCompositionEndGuard(root, deliver)
    cleanup()

    fireInput('beforeinput', 'insertFromComposition', 'é')
    textarea.value += 'é'
    fireInput('input', 'insertFromComposition', 'é')

    expect(delivered).toEqual([])
    expect(textarea.value).toBe('é')
  })
})
