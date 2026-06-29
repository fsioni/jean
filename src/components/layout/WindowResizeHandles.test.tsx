import { fireEvent, render, screen } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowResizeHandles } from './WindowResizeHandles'

const startResizeDragging = vi.fn()

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startResizeDragging }),
}))

let maximized = false

vi.mock('@/hooks/use-window-maximized', () => ({
  useWindowMaximized: () => maximized,
}))

describe('WindowResizeHandles', () => {
  beforeEach(() => {
    maximized = false
    startResizeDragging.mockReset()
  })

  it('starts native resize dragging for each edge and corner', () => {
    render(<WindowResizeHandles />)

    const directions = [
      'NorthWest',
      'North',
      'NorthEast',
      'East',
      'SouthEast',
      'South',
      'SouthWest',
      'West',
    ] as const

    for (const direction of directions) {
      fireEvent.mouseDown(screen.getByTestId(`window-resize-${direction}`), {
        button: 0,
      })
    }

    expect(startResizeDragging.mock.calls.map(call => call[0])).toEqual(
      directions
    )
  })

  it('ignores non-primary mouse buttons', () => {
    render(<WindowResizeHandles />)

    fireEvent.mouseDown(screen.getByTestId('window-resize-East'), { button: 1 })

    expect(startResizeDragging).not.toHaveBeenCalled()
  })

  it('does not render handles while maximized', () => {
    maximized = true

    render(<WindowResizeHandles />)

    expect(screen.queryByTestId('window-resize-East')).toBeNull()
  })
})
