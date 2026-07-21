import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@/test/test-utils'
import { BrowserToolbar } from './BrowserToolbar'
import { useBrowserStore } from '@/store/browser-store'

const actionsMock = vi.hoisted(() => ({
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  reload: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  focus: vi.fn(),
  enableGrab: vi.fn(),
}))

vi.mock('@/hooks/useBrowserPane', () => ({
  useBrowserTabActions: () => actionsMock,
  browserBackend: {
    close: vi.fn(),
  },
}))

describe('BrowserToolbar grab control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actionsMock.enableGrab.mockResolvedValue(undefined)
    useBrowserStore.setState({
      tabs: {},
      activeTabIds: {},
      sidePaneOpen: {},
      modalOpen: {},
      bottomPanelOpen: {},
    })
    useBrowserStore.getState().addTab('worktree-1', 'http://localhost:3000')
  })

  it('enables React Grab for the active tab when the Grab button is clicked', async () => {
    render(<BrowserToolbar worktreeId="worktree-1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Grab DOM element' }))

    expect(actionsMock.enableGrab).toHaveBeenCalledTimes(1)
  })
})
