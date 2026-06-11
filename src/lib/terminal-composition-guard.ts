/**
 * WebKitGTK (Tauri's Linux webview) with an ibus input method commits
 * composed characters — é, ç, à on AZERTY, dead-key combos, etc. — WITHOUT a
 * `compositionstart`: each keystroke arrives as `keydown keyCode=229` +
 * `input insertFromComposition` + an orphan `compositionend`.
 *
 * xterm.js's CompositionHelper assumes balanced composition events, and this
 * breaks it twice over:
 *
 * 1. On an orphan `compositionend` its `_compositionPosition.start` is stuck
 *    at 0, so it re-sends the hidden textarea's accumulated content on every
 *    keystroke (é → éé → ééé…). The guard swallows orphan ends in the capture
 *    phase on the terminal host element (an ancestor of xterm's textarea), so
 *    they never reach xterm's own listeners.
 *
 * 2. With orphan ends swallowed, the composed char's only remaining delivery
 *    path is `_handleAnyTextareaChanges`: snapshot `textarea.value` on
 *    keydown(229), send the diff in a `setTimeout(0)`. ibus is asynchronous,
 *    so the keydown/input/compositionend triplets of consecutive keystrokes
 *    can arrive in one burst (DBus latency, main-thread jank) before any
 *    timer runs — both keydowns snapshot, then timer 1 diffs against a value
 *    that already contains BOTH chars and re-sends the second one ("ééé" for
 *    two keystrokes, intermittently, under load). When `deliverOrphanData` is
 *    provided, the guard therefore takes over delivery at the `input` event:
 *    an `insertFromComposition` outside any open composition has its data
 *    stripped from the textarea (so xterm's racy diff never sees composed
 *    chars, and the textarea no longer accumulates them) and delivered
 *    exactly once through the callback.
 *
 * Balanced sequences (real IME input: CJK preedit, etc.) pass through
 * untouched — their commit `input` targets the element that opened the
 * composition — which also makes the guard a no-op on platforms that don't
 * have this quirk.
 *
 * Balance is tracked per source element: a `compositionend` is only
 * "balanced" (and forwarded) when it targets the same element that opened the
 * composition. This keeps the guard correct even if several
 * composition-capable descendants ever live under `root`.
 *
 * Returns a cleanup function removing the listeners.
 */
export function attachOrphanCompositionEndGuard(
  root: HTMLElement,
  deliverOrphanData?: (data: string) => void
): () => void {
  let compositionTarget: EventTarget | null = null

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

  const onInput = (event: Event): void => {
    if (!deliverOrphanData) {
      return
    }
    const { inputType, data } = event as InputEvent
    if (inputType !== 'insertFromComposition' || !data) {
      return
    }
    const target = event.target
    if (
      target === compositionTarget ||
      !(target instanceof HTMLTextAreaElement) ||
      !target.value.endsWith(data)
    ) {
      return
    }
    target.value = target.value.slice(0, target.value.length - data.length)
    deliverOrphanData(data)
  }

  root.addEventListener('compositionstart', onCompositionStart, true)
  root.addEventListener('compositionend', onCompositionEnd, true)
  root.addEventListener('input', onInput, true)

  return () => {
    root.removeEventListener('compositionstart', onCompositionStart, true)
    root.removeEventListener('compositionend', onCompositionEnd, true)
    root.removeEventListener('input', onInput, true)
  }
}
