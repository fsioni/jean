import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test/test-utils'
import { WebAccessPane } from './WebAccessPane'
import { defaultPreferences } from '@/types/preferences'

const invokeMock = vi.fn()

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => false,
  hasBackend: () => true,
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn() }))
vi.mock('@/lib/platform', () => ({
  isMacOS: false,
  isWindows: false,
  isLinux: true,
  getServerPlatform: vi.fn(() => 'linux'),
  isServerWindows: vi.fn(() => false),
  openExternal: vi.fn(),
}))

describe('WebAccessPane in browser/headless mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockImplementation((command: string) => {
      if (command === 'load_preferences') return Promise.resolve(defaultPreferences)
      if (command === 'get_http_server_status') {
        return Promise.resolve({
          running: true,
          port: 3456,
          url: 'http://0.0.0.0:3456',
          token: 'secret-token',
          bind_host: '0.0.0.0',
          localhost_only: false,
        })
      }
      if (command === 'list_http_bind_host_options') return Promise.resolve([])
      return Promise.resolve(null)
    })
  })

  it('shows web access controls in browser mode so headless users can configure it', async () => {
    render(<WebAccessPane />)

    await waitFor(() => {
      expect(screen.getByText('Enable HTTP server')).toBeInTheDocument()
    })
    expect(screen.queryByText(/only available in the desktop app/i)).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('secret-token')).toBeInTheDocument()
  })
})
