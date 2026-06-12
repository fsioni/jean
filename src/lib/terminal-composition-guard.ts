/**
 * WebKitGTK (Tauri's Linux webview) with an ibus input method routes ALL text
 * input through the input-method layer, which breaks xterm.js's hidden
 * textarea bookkeeping twice over (every fact below is trace-proven on a
 * live WebKitGTK build):
 *
 * 1. Composed characters — é, ç, à on AZERTY, dead-key combos, etc. — commit
 *    WITHOUT a `compositionstart`: each keystroke arrives as `keydown
 *    keyCode=229` + `input insertFromComposition` + an orphan
 *    `compositionend`. On such an orphan end xterm's CompositionHelper
 *    re-sends the textarea's accumulated content (é → éé → ééé…). The guard
 *    swallows orphan ends in the capture phase on the terminal host element
 *    (an ancestor of xterm's textarea), so they never reach xterm's own
 *    listeners.
 *
 * 2. The IM inserts committed text into the textarea even for keys xterm
 *    already handled and preventDefault()ed: every typed space and shifted
 *    letter accumulates there (xterm only clears the value on Enter, Ctrl+C
 *    and blur). That residue then leaks to the PTY through
 *    `CompositionHelper._handleAnyTextareaChanges`, which is scheduled on
 *    every keydown(229), snapshots the value, and in a setTimeout(0):
 *      - value grew      → sends the diff (duplicates composed chars when
 *        keystroke triplets arrive in one burst before any timer runs);
 *      - value shrank    → sends DEL, erasing the just-typed accent (WebKit's
 *        stale composition range can make a commit REPLACE the last char);
 *      - same length but different content → sends the ENTIRE textarea value
 *        (WebKit's editing layer normalizes a trailing NBSP to a plain space
 *        while committing, so the accumulated junk bursts into the PTY).
 *
 * When `deliverOrphanData` is provided, the guard therefore restores the
 * textarea on every IM echo: it snapshots `textarea.value` on `beforeinput`
 * and writes it back verbatim on `input`, so xterm's diff timer always sees
 * oldValue === newValue and none of its branches can fire. The snapshot is
 * restored (rather than the committed data suffix-stripped) because the UA
 * mutation is not always a plain append — it may replace a char or rewrite
 * an NBSP — and the echoed insertion does not always equal `event.data`
 * (typed spaces are inserted as NBSP).
 *
 *    - `insertFromComposition` outside any open composition (the orphan
 *      commit): restore the snapshot and deliver the data exactly once via
 *      the callback.
 *    - `insertText` whose key xterm already delivered directly (last keydown
 *      ≠ 229, no composition open): restore the snapshot only. Keys pressed
 *      while an IME is active (keydown 229 + insertText) stay on xterm's
 *      grow-diff path, which is the only thing that delivers them.
 *
 * Balanced sequences (real IME input: CJK preedit, dead-key ê on this
 * platform, etc.) pass through untouched — their commit `input` targets the
 * element that opened the composition — which also makes the guard a no-op
 * on platforms that don't have this quirk. Balance is tracked per source
 * element: a `compositionend` is only "balanced" (and forwarded) when it
 * targets the same element that opened the composition. This keeps the guard
 * correct even if several composition-capable descendants ever live under
 * `root`.
 *
 * Returns a cleanup function removing the listeners.
 */
export function attachOrphanCompositionEndGuard(
  root: HTMLElement,
  deliverOrphanData?: (data: string) => void
): () => void {
  let compositionTarget: EventTarget | null = null
  let lastKeydownKeyCode: number | null = null
  let pendingRestore: {
    target: HTMLTextAreaElement
    value: string
    deliver: string | null
  } | null = null

  const onKeyDown = (event: Event): void => {
    lastKeydownKeyCode = (event as KeyboardEvent).keyCode
    pendingRestore = null
  }

  const onCompositionStart = (event: Event): void => {
    compositionTarget = event.target
  }

  const onCompositionEnd = (event: Event): void => {
    if (compositionTarget !== null && event.target === compositionTarget) {
      compositionTarget = null
      return
    }
    event.stopPropagation()
  }

  const onBeforeInput = (event: Event): void => {
    if (!deliverOrphanData) {
      return
    }
    const { inputType, data } = event as InputEvent
    const target = event.target
    if (!data || !(target instanceof HTMLTextAreaElement)) {
      return
    }
    if (inputType === 'insertFromComposition' && target !== compositionTarget) {
      pendingRestore = { target, value: target.value, deliver: data }
    } else if (
      inputType === 'insertText' &&
      compositionTarget === null &&
      lastKeydownKeyCode !== null &&
      lastKeydownKeyCode !== 229
    ) {
      pendingRestore = { target, value: target.value, deliver: null }
    }
  }

  const onInput = (event: Event): void => {
    if (!pendingRestore) {
      return
    }
    const { target, value, deliver } = pendingRestore
    pendingRestore = null
    if (event.target !== target) {
      return
    }
    target.value = value
    if (deliver && deliverOrphanData) {
      deliverOrphanData(deliver)
    }
  }

  root.addEventListener('keydown', onKeyDown, true)
  root.addEventListener('compositionstart', onCompositionStart, true)
  root.addEventListener('compositionend', onCompositionEnd, true)
  root.addEventListener('beforeinput', onBeforeInput, true)
  root.addEventListener('input', onInput, true)

  return () => {
    root.removeEventListener('keydown', onKeyDown, true)
    root.removeEventListener('compositionstart', onCompositionStart, true)
    root.removeEventListener('compositionend', onCompositionEnd, true)
    root.removeEventListener('beforeinput', onBeforeInput, true)
    root.removeEventListener('input', onInput, true)
  }
}
