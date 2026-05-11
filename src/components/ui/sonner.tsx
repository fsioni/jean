import { useEffect, useRef } from 'react'
import { useTheme } from '@/hooks/use-theme'
import {
  Toaster as Sonner,
  toast,
  useSonner,
  type ToasterProps,
  type ToastT,
} from 'sonner'

const POINTER_DISMISS_THRESHOLD = 28
const WHEEL_DISMISS_THRESHOLD = 32
const WHEEL_DISMISS_RESET_MS = 180

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a'))
}

function getToastElement(target: EventTarget | null): Element | null {
  return (target as Element | null)?.closest?.('[data-sonner-toast]') ?? null
}

function getToastsForPosition(
  toasts: ToastT[],
  position: ToasterProps['position']
): ToastT[] {
  return toasts.filter(currentToast => {
    if (!currentToast.position) return true
    return currentToast.position === position
  })
}

function ToastGestureDismiss({ position }: Pick<ToasterProps, 'position'>) {
  const { toasts } = useSonner()
  const toastsRef = useRef(toasts)
  const positionRef = useRef(position)
  const pointerStateRef = useRef<{
    element: Element | null
    pointerId: number | null
    startX: number
    startY: number
  }>({ element: null, pointerId: null, startX: 0, startY: 0 })
  const wheelStateRef = useRef<{
    element: Element | null
    distance: number
    timeout: ReturnType<typeof setTimeout> | null
  }>({ element: null, distance: 0, timeout: null })

  useEffect(() => {
    toastsRef.current = toasts
  }, [toasts])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => {
    const resetWheelState = () => {
      const state = wheelStateRef.current
      if (state.timeout) clearTimeout(state.timeout)
      wheelStateRef.current = { element: null, distance: 0, timeout: null }
    }

    const resetPointerState = () => {
      pointerStateRef.current = {
        element: null,
        pointerId: null,
        startX: 0,
        startY: 0,
      }
    }

    const dismissToastFromElement = (toastElement: Element) => {
      const index = Number(toastElement.getAttribute('data-index'))
      if (!Number.isInteger(index)) return

      const positionedToasts = getToastsForPosition(
        toastsRef.current,
        positionRef.current
      )
      const targetToast = positionedToasts[index]
      if (!targetToast || targetToast.dismissible === false) return

      toast.dismiss(targetToast.id)
      resetWheelState()
      resetPointerState()
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 2 || isInteractiveTarget(event.target)) return
      const toastElement = getToastElement(event.target)
      if (!toastElement) return

      pointerStateRef.current = {
        element: toastElement,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      }
    }

    const handlePointerUp = (event: PointerEvent) => {
      const state = pointerStateRef.current
      if (!state.element || state.pointerId !== event.pointerId) return

      const distance = Math.max(
        Math.abs(event.clientX - state.startX),
        Math.abs(event.clientY - state.startY)
      )
      const toastElement = state.element
      resetPointerState()

      if (distance >= POINTER_DISMISS_THRESHOLD) {
        dismissToastFromElement(toastElement)
      }
    }

    const handleWheel = (event: WheelEvent) => {
      if (isInteractiveTarget(event.target)) return
      const toastElement = getToastElement(event.target)
      if (!toastElement) return

      const state = wheelStateRef.current
      if (state.element !== toastElement) {
        resetWheelState()
        wheelStateRef.current.element = toastElement
      }

      const nextState = wheelStateRef.current
      const distance = Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY))
      nextState.distance += distance
      if (nextState.timeout) clearTimeout(nextState.timeout)
      nextState.timeout = setTimeout(resetWheelState, WHEEL_DISMISS_RESET_MS)

      if (nextState.distance >= WHEEL_DISMISS_THRESHOLD) {
        event.preventDefault()
        dismissToastFromElement(toastElement)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', resetPointerState)
    document.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      resetWheelState()
      resetPointerState()
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', resetPointerState)
      document.removeEventListener('wheel', handleWheel)
    }
  }, [])

  return null
}

const Toaster = ({ position, ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()
  const resolvedPosition = position ?? 'bottom-right'

  return (
    <>
      <Sonner
        theme={theme as ToasterProps['theme']}
        position={resolvedPosition}
        className="toaster group"
        style={
          {
            '--normal-bg': 'var(--sidebar)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--border)',
          } as React.CSSProperties
        }
        {...props}
      />
      <ToastGestureDismiss position={resolvedPosition} />
    </>
  )
}

export { Toaster }
