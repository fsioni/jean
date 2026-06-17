import { describe, expect, it } from 'vitest'
import {
  capturePrependScrollAnchor,
  restorePrependScrollAnchor,
} from './message-scroll-anchor'

function mockRect(element: Element, top: number, bottom: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top,
      bottom,
      left: 0,
      right: 100,
      width: 100,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
  })
}

function setupContainer() {
  const container = document.createElement('div')
  container.scrollTop = 250
  mockRect(container, 100, 500)
  document.body.appendChild(container)
  return container
}

function appendMessage(
  container: HTMLElement,
  id: string,
  top: number,
  bottom: number
) {
  const el = document.createElement('div')
  el.dataset.messageAnchorId = id
  mockRect(el, top, bottom)
  container.appendChild(el)
  return el
}

describe('message scroll anchor', () => {
  it('captures the first visible message and restores its viewport offset after prepending messages', () => {
    const container = setupContainer()
    appendMessage(container, 'older-hidden', 20, 90)
    const anchorEl = appendMessage(container, 'current-first-visible', 140, 220)
    appendMessage(container, 'current-second-visible', 230, 320)

    const anchor = capturePrependScrollAnchor(container)

    expect(anchor).toEqual({
      messageId: 'current-first-visible',
      offsetTop: 40,
    })

    mockRect(anchorEl, 360, 440)
    restorePrependScrollAnchor(container, anchor)

    expect(container.scrollTop).toBe(470)
  })

  it('does not move scroll position when the captured message is no longer rendered', () => {
    const container = setupContainer()
    appendMessage(container, 'visible-before-load', 140, 220)
    const anchor = capturePrependScrollAnchor(container)
    container.replaceChildren()

    restorePrependScrollAnchor(container, anchor)

    expect(container.scrollTop).toBe(250)
  })
})
