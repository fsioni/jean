/**
 * WebKitGTK (Tauri's Linux webview) with an ibus input method commits
 * composed characters — é, ç, à on AZERTY, dead-key combos, etc. — by firing
 * `compositionend` WITHOUT a preceding `compositionstart` (the keystroke
 * arrives as `keydown keyCode=229` + `input insertFromComposition` +
 * `compositionend`).
 *
 * xterm.js's CompositionHelper assumes balanced composition events. On an
 * orphan `compositionend` its `_compositionPosition.start` is stuck at 0, so
 * it re-sends the hidden textarea's accumulated content on every keystroke:
 * typing ééé produces é, é+é, é+éé… The character itself is already delivered
 * once, correctly, through xterm's keydown(229) textarea-diff path
 * (`_handleAnyTextareaChanges`), so the orphan event is safe to swallow.
 *
 * The guard listens in the capture phase on the terminal host element — an
 * ancestor of xterm's hidden textarea — so it runs before xterm's own
 * listeners and can stop orphan events from ever reaching them. Balanced
 * sequences (real IME input: CJK preedit, etc.) pass through untouched, which
 * also makes the guard a no-op on platforms that don't have this quirk.
 *
 * Returns a cleanup function removing the listeners.
 */
export function attachOrphanCompositionEndGuard(root: HTMLElement): () => void {
  let sawCompositionStart = false

  const onCompositionStart = (): void => {
    sawCompositionStart = true
  }

  const onCompositionEnd = (event: Event): void => {
    if (sawCompositionStart) {
      sawCompositionStart = false
      return
    }
    event.stopPropagation()
  }

  root.addEventListener('compositionstart', onCompositionStart, true)
  root.addEventListener('compositionend', onCompositionEnd, true)

  return () => {
    root.removeEventListener('compositionstart', onCompositionStart, true)
    root.removeEventListener('compositionend', onCompositionEnd, true)
  }
}
