import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServersPane } from './McpServersPane'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  jeanMcpEnabled: true,
  patchPreferencesMutate: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
  },
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      jean_mcp_enabled: mocks.jeanMcpEnabled,
      jean_mcp_max_depth: 3,
      jean_mcp_rate_limit_per_minute: 20,
      default_enabled_mcp_servers: [],
      known_mcp_servers: [],
    },
  }),
  usePatchPreferences: () => ({ mutate: mocks.patchPreferencesMutate }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    installedBackends: ['codex', 'cursor'],
    isLoading: false,
  }),
}))

vi.mock('@/services/mcp', () => ({
  useAllBackendsMcpServers: () => ({ data: [], isLoading: false }),
  invalidateAllMcpServers: vi.fn(),
  getNewServersToAutoEnable: vi.fn(() => []),
  useAllBackendsMcpHealth: () => ({
    statuses: {},
    isFetching: false,
    refetchAll: vi.fn(),
  }),
  groupServersByBackend: vi.fn(() => ({})),
  mcpKey: vi.fn((backend: string, name: string) => `${backend}:${name}`),
  migrateLegacyMcpKeys: vi.fn((keys: string[]) => ({
    changed: false,
    migrated: keys,
  })),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: vi.fn(selector => selector({ activeWorktreePath: null })),
}))

const snippet = {
  enabled: true,
  server_running: true,
  mode: 'prod',
  server_name: 'jean',
  url: null,
  token: null,
  claude: '{}',
  cursor: '{}',
  codex_toml: '[mcp_servers.jean]',
  opencode_json: '{}',
}

describe('McpServersPane Jean MCP install', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.jeanMcpEnabled = true
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'get_jean_mcp_config_snippet') return snippet
      if (command === 'install_jean_mcp_config') {
        return [
          {
            backend: 'codex',
            status: 'installed',
            path: '/tmp/codex.toml',
            backupPath: null,
            serverName: 'jean',
            mode: 'prod',
            message: 'ok',
          },
          {
            backend: 'cursor',
            status: 'installed',
            path: '/tmp/mcp.json',
            backupPath: null,
            serverName: 'jean',
            mode: 'prod',
            message: 'ok',
          },
        ]
      }
      return null
    })
  })

  it('shows successful install confirmation on the button instead of a toast', async () => {
    const user = userEvent.setup()
    render(<McpServersPane />)

    const button = await screen.findByRole('button', {
      name: /add current jean mcp/i,
    })
    await waitFor(() => expect(button).not.toBeDisabled())

    await user.click(button)

    const addedButton = await screen.findByRole('button', { name: /^added$/i })
    expect(addedButton).toBeInTheDocument()
    expect(addedButton).toBeDisabled()
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows install failure on the button instead of a toast', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'get_jean_mcp_config_snippet') return snippet
      if (command === 'install_jean_mcp_config') {
        throw new Error('disk full')
      }
      return null
    })

    const user = userEvent.setup()
    render(<McpServersPane />)

    const button = await screen.findByRole('button', {
      name: /add current jean mcp/i,
    })
    await waitFor(() => expect(button).not.toBeDisabled())

    await user.click(button)

    expect(
      await screen.findByRole('button', { name: /failed to add jean mcp/i })
    ).toBeInTheDocument()
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('asks whether to add Jean MCP automatically or manually when enabling', async () => {
    mocks.jeanMcpEnabled = false
    const user = userEvent.setup()
    render(<McpServersPane />)

    await user.click(
      await screen.findByRole('switch', { name: /enable jean mcp stdio/i })
    )

    expect(mocks.patchPreferencesMutate).toHaveBeenCalledWith({
      jean_mcp_enabled: true,
    })
    expect(
      await screen.findByRole('alertdialog', {
        name: /add jean mcp to your cli configs/i,
      })
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /add automatically/i })
    )

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('install_jean_mcp_config', {
        backends: ['codex', 'cursor'],
        mode: 'current',
      })
    )
  })
})
