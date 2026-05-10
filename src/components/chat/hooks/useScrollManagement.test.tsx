import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useScrollManagement } from './useScrollManagement'

let isMobile = false

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0]

let resizeObserverCallback: ResizeObserverCallback | null = null

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback
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

function setupHook() {
  const virtualizedListRef = { current: null }

  function TestHarness() {
    const { scrollViewportRef } = useScrollManagement({
      messages: [],
      virtualizedListRef,
      activeWorktreeId: 'worktree-1',
      isSending: true,
    })

    return (
      <div ref={scrollViewportRef} data-testid="viewport">
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
    resizeObserverCallback?.([], {} as ResizeObserver)
  })
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}

describe('useScrollManagement streaming auto-scroll', () => {
  beforeEach(() => {
    isMobile = false
    resizeObserverCallback = null
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
})
