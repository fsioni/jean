import { isNativeApp } from './environment'
import { invoke } from './transport'

/**
 * Copy text to clipboard with fallback for insecure contexts (HTTP).
 *
 * Fallback chain:
 * 1. Native app → Tauri clipboard plugin
 * 2. Secure context → navigator.clipboard.writeText()
 * 3. Insecure context → document.execCommand('copy') with hidden textarea
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (isNativeApp()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Browser clipboard can be denied in web access after async command work.
      // Fall through to local fallbacks instead of reporting success with no copy.
    }
  }

  // Fallback for insecure contexts (HTTP web access)
  if (execCommandCopyFallback(text)) return

  // Last resort for Jean web access on the same machine: ask the backend to
  // write the OS clipboard. This fixes command-palette actions that fetch data
  // asynchronously before copying, which can lose browser user activation.
  await invoke('write_clipboard_text', { text })
}

/**
 * Copy rich content (HTML + plain text) to clipboard.
 * Falls back to plain text copy if ClipboardItem API is unavailable.
 */
export async function copyHtmlToClipboard(
  html: string,
  plainText: string,
  fallbackPlainText = plainText
): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ])
    return
  }

  // Fall back to plain text
  await copyToClipboard(fallbackPlainText)
}

function execCommandCopyFallback(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}
