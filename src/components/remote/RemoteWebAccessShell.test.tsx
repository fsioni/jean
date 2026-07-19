import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@/test/test-utils'
import { RemoteWebAccessShell } from './RemoteWebAccessShell'

const browserBackend = vi.hoisted(() => ({
  create: vi.fn(),
  setBounds: vi.fn(),
  setVisible: vi.fn(),
  eval: vi.fn(),
  hasActive: vi.fn(),
  close: vi.fn(),
}))

vi.mock('@/hooks/useBrowserPane', () => ({ browserBackend }))
vi.mock('./RemoteConnectionsDialog', () => ({
  RemoteConnectionsDialog: ({
    onOpenChange,
  }: {
    onOpenChange?: (open: boolean) => void
  }) => <button onClick={() => onOpenChange?.(true)}>Connections</button>,
}))
vi.mock('@/components/titlebar/LinuxWindowControls', () => ({
  LinuxWindowControls: () => null,
}))

describe('RemoteWebAccessShell', () => {
  beforeEach(() => {
    browserBackend.create.mockResolvedValue(undefined)
    browserBackend.setBounds.mockResolvedValue(undefined)
    browserBackend.setVisible.mockResolvedValue(undefined)
    browserBackend.eval.mockResolvedValue(undefined)
    browserBackend.hasActive.mockResolvedValue(false)
    browserBackend.close.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads the selected server UI in a restricted child webview', async () => {
    render(
      <RemoteWebAccessShell
        connection={{
          id: 'remote-1',
          name: 'Build server',
          url: 'https://jean.example.com',
          token: 'secret',
        }}
      />
    )

    await waitFor(() => {
      expect(browserBackend.create).toHaveBeenCalledWith(
        'remote-jean-ui',
        'https://jean.example.com/?token=secret&jean_native_shell=1',
        expect.objectContaining({ width: 1, height: 1 })
      )
    })
  })

  it('hides the child webview while the local connection dialog is open', async () => {
    render(
      <RemoteWebAccessShell
        connection={{
          id: 'remote-1',
          name: 'Build server',
          url: 'https://jean.example.com',
          token: 'secret',
        }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Connections' }))

    await waitFor(() => {
      expect(browserBackend.setVisible).toHaveBeenCalledWith(
        'remote-jean-ui',
        false
      )
    })
  })

  it('keeps sidebar and settings controls in the local shell header', async () => {
    render(
      <RemoteWebAccessShell
        connection={{
          id: 'remote-1',
          name: 'Build server',
          url: 'https://jean.example.com',
          token: 'secret',
        }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))

    await waitFor(() => {
      expect(browserBackend.eval).toHaveBeenCalledWith(
        'remote-jean-ui',
        expect.stringContaining('toggle-sidebar')
      )
      expect(browserBackend.eval).toHaveBeenCalledWith(
        'remote-jean-ui',
        expect.stringContaining('open-preferences')
      )
    })
  })
})
