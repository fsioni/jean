import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useScrollManagement } from './useScrollManagement'

let isMobile = false

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0]

let resizeObserverCallbacks: ResizeObserverCallback[] = []

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback)
  }

  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

class IntersectionObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function defineReadonlyNumber(
  element: HTMLElement,
  property: 'clientHeight' | 'scrollHeight' | 'offsetTop',
  value: number
) {
  Object.defineProperty(element, property, {
    configurable: true,
    value,
  })
}

interface SetupHookOptions {
  isSending?: boolean
}

function setupHook({ isSending = true }: SetupHookOptions = {}) {
  const virtualizedListRef = { current: null }

  function TestHarness() {
    const { isAtBottom, scrollViewportRef } = useScrollManagement({
      messages: [],
      virtualizedListRef,
      activeWorktreeId: 'worktree-1',
      isSending,
    })

    return (
      <div ref={scrollViewportRef} data-testid="viewport">
        <span data-testid="is-at-bottom">{String(isAtBottom)}</span>
        <div data-testid="content">
          <div data-plan-display data-testid="plan" />
        </div>
      </div>
    )
  }

  const renderResult = render(<TestHarness />)
  const viewport = renderResult.getByTestId('viewport')
  const plan = renderResult.getByTestId('plan')

  defineReadonlyNumber(viewport, 'clientHeight', 400)
  defineReadonlyNumber(viewport, 'scrollHeight', 2000)
  defineReadonlyNumber(plan, 'offsetTop', 600)

  return { ...renderResult, viewport, plan }
}

async function triggerResize() {
  await act(async () => {
    for (const callback of resizeObserverCallbacks) {
      callback([], {} as ResizeObserver)
    }
  })
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}

describe('useScrollManagement streaming auto-scroll', () => {
  beforeEach(() => {
    isMobile = false
    resizeObserverCallbacks = []
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function scrollTo(options: ScrollToOptions) {
        if (typeof options.top === 'number') {
          this.scrollTop = options.top
        }
      },
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(performance.now())
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps desktop plan pinning during streaming', async () => {
    const { viewport } = setupHook()

    await triggerResize()

    expect(viewport.scrollTop).toBe(600)
  })

  it('follows the streaming tail on mobile even when a plan is visible', async () => {
    isMobile = true
    const { viewport } = setupHook()

    await triggerResize()

    expect(viewport.scrollTop).toBe(2000)
  })

  it('does not auto-scroll after the user scrolls up', async () => {
    isMobile = true
    const { viewport } = setupHook()
    viewport.scrollTop = 1500

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })
    await triggerResize()

    expect(viewport.scrollTop).toBe(1500)
  })

  it('keeps non-scrollable chats at bottom after upward wheel gestures', () => {
    const { getByTestId, viewport } = setupHook({ isSending: false })
    defineReadonlyNumber(viewport, 'clientHeight', 600)
    defineReadonlyNumber(viewport, 'scrollHeight', 500)

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })

    expect(getByTestId('is-at-bottom')).toHaveTextContent('true')
  })

  it('marks scrollable chats as away from bottom after upward wheel gestures', () => {
    const { getByTestId, viewport } = setupHook({ isSending: false })
    defineReadonlyNumber(viewport, 'clientHeight', 400)
    defineReadonlyNumber(viewport, 'scrollHeight', 2000)
    viewport.scrollTop = 1500

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })

    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')
  })

  it('resets stale away-from-bottom state when content no longer overflows', async () => {
    const { getByTestId, viewport } = setupHook({ isSending: false })
    defineReadonlyNumber(viewport, 'clientHeight', 400)
    defineReadonlyNumber(viewport, 'scrollHeight', 2000)
    viewport.scrollTop = 1500

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })

    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')

    defineReadonlyNumber(viewport, 'scrollHeight', 350)
    await triggerResize()

    expect(getByTestId('is-at-bottom')).toHaveTextContent('true')
  })
})
