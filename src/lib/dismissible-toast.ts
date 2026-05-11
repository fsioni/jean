import type { ReactNode } from 'react'
import { toast, type ExternalToast } from 'sonner'

type ToastKind = 'success' | 'error' | 'warning' | 'info' | 'loading'

type ToastUpdater = (message: ReactNode, options?: ExternalToast) => void

export interface DismissibleToastHandle {
  id: string | number
  readonly dismissed: boolean
  success: ToastUpdater
  error: ToastUpdater
  warning: ToastUpdater
  info: ToastUpdater
  loading: ToastUpdater
}

function withDismissHandler(
  options: ExternalToast | undefined,
  onDismiss: NonNullable<ExternalToast['onDismiss']>
): ExternalToast {
  return {
    ...options,
    dismissible: true,
    onDismiss: currentToast => {
      onDismiss(currentToast)
      options?.onDismiss?.(currentToast)
    },
  }
}

function updateToast(
  kind: ToastKind,
  message: ReactNode,
  options: ExternalToast
): void {
  toast[kind](message, options)
}

export const dismissibleToast = {
  loading(message: ReactNode, options?: ExternalToast): DismissibleToastHandle {
    let wasDismissed = false
    const markDismissed: NonNullable<ExternalToast['onDismiss']> = () => {
      wasDismissed = true
    }

    const id = toast.loading(
      message,
      withDismissHandler(options, markDismissed)
    )

    const update = (
      kind: ToastKind,
      nextMessage: ReactNode,
      nextOptions = {}
    ) => {
      if (wasDismissed) return
      updateToast(
        kind,
        nextMessage,
        withDismissHandler(
          {
            ...nextOptions,
            id,
          },
          markDismissed
        )
      )
    }

    return {
      id,
      get dismissed() {
        return wasDismissed
      },
      success: (nextMessage, nextOptions) =>
        update('success', nextMessage, nextOptions),
      error: (nextMessage, nextOptions) =>
        update('error', nextMessage, nextOptions),
      warning: (nextMessage, nextOptions) =>
        update('warning', nextMessage, nextOptions),
      info: (nextMessage, nextOptions) =>
        update('info', nextMessage, nextOptions),
      loading: (nextMessage, nextOptions) =>
        update('loading', nextMessage, nextOptions),
    }
  },
}
