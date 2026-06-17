export interface PrependScrollAnchor {
  messageId: string
  offsetTop: number
}

const MESSAGE_ANCHOR_SELECTOR = '[data-message-anchor-id]'

function getMessageAnchorId(element: Element): string | null {
  return element instanceof HTMLElement
    ? (element.dataset.messageAnchorId ?? null)
    : null
}

function getViewportOffsetTop(container: HTMLElement, element: HTMLElement) {
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  return elementRect.top - containerRect.top
}

export function capturePrependScrollAnchor(
  container: HTMLElement
): PrependScrollAnchor | null {
  const containerRect = container.getBoundingClientRect()
  const messageElements = Array.from(
    container.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)
  )

  const firstVisible = messageElements.find(element => {
    const rect = element.getBoundingClientRect()
    return rect.bottom > containerRect.top && rect.top < containerRect.bottom
  })

  if (!firstVisible) return null

  const messageId = getMessageAnchorId(firstVisible)
  if (!messageId) return null

  return {
    messageId,
    offsetTop: getViewportOffsetTop(container, firstVisible),
  }
}

export function restorePrependScrollAnchor(
  container: HTMLElement,
  anchor: PrependScrollAnchor | null
) {
  if (!anchor) return

  const messageElements = Array.from(
    container.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)
  )
  const anchoredElement = messageElements.find(
    element => getMessageAnchorId(element) === anchor.messageId
  )
  if (!anchoredElement) return

  const offsetAfterPrepend = getViewportOffsetTop(container, anchoredElement)
  container.scrollTop += offsetAfterPrepend - anchor.offsetTop
}
