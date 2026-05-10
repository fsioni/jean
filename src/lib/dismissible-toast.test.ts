import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast, type ToastT } from 'sonner'
import { dismissibleToast } from './dismissible-toast'

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

const mockToast = { id: 'toast-id' } as ToastT

describe('dismissibleToast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(toast.loading).mockReturnValue('toast-id')
  })

  it('creates dismissible loading toasts', () => {
    dismissibleToast.loading('Working...')

    expect(toast.loading).toHaveBeenCalledWith(
      'Working...',
      expect.objectContaining({ dismissible: true })
    )
  })

  it('updates an active toast with the original id', () => {
    const handle = dismissibleToast.loading('Working...')

    handle.success('Done')

    expect(toast.success).toHaveBeenCalledWith(
      'Done',
      expect.objectContaining({ id: 'toast-id', dismissible: true })
    )
  })

  it('does not update after the user dismisses the toast', () => {
    const handle = dismissibleToast.loading('Working...')
    const options = vi.mocked(toast.loading).mock.calls[0]?.[1]

    options?.onDismiss?.(mockToast)
    handle.error('Failed')

    expect(handle.dismissed).toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('preserves caller onDismiss callbacks', () => {
    const onDismiss = vi.fn()

    dismissibleToast.loading('Working...', { onDismiss })
    const options = vi.mocked(toast.loading).mock.calls[0]?.[1]
    options?.onDismiss?.(mockToast)

    expect(onDismiss).toHaveBeenCalledWith(mockToast)
  })

  it('does not resurrect dismissed toasts for any completion variant', () => {
    const handle = dismissibleToast.loading('Working...')
    const options = vi.mocked(toast.loading).mock.calls[0]?.[1]

    options?.onDismiss?.(mockToast)
    handle.success('Done')
    handle.warning('Careful')
    handle.info('FYI')
    handle.loading('Still working')

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.loading).toHaveBeenCalledTimes(1)
  })
})
