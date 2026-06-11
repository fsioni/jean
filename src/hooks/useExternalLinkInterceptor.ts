import { useEffect } from 'react'
import { openExternal } from '@/lib/platform'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

function getAnchorFromEventTarget(
  target: EventTarget | null
): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null
  return target.closest('a[href]')
}

function shouldOpenExternally(anchor: HTMLAnchorElement): boolean {
  if (anchor.hasAttribute('download')) return false

  const rawHref = anchor.getAttribute('href')
  if (!rawHref || rawHref.startsWith('#')) return false

  let url: URL
  try {
    url = new URL(rawHref, window.location.href)
  } catch {
    return false
  }

  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false

  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === window.location.origin
  ) {
    return false
  }

  return true
}

/**
 * Ensure app-authored external links open in the OS/default browser instead of
 * being handled by the current WebView (which opens an embedded browser on
 * mobile). Programmatic callers should use openExternal() directly; this hook
 * covers raw anchors rendered by Markdown and third-party UI content.
 */
export function useExternalLinkInterceptor(): void {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return

      const anchor = getAnchorFromEventTarget(event.target)
      if (!anchor || !shouldOpenExternally(anchor)) return

      event.preventDefault()
      event.stopPropagation()

      void openExternal(anchor.href).catch(error => {
        console.error('Failed to open external link', error)
      })
    }

    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [])
}
