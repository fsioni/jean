/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor, within } from '@/test/test-utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ApprovalModelSubmenu } from './ApprovalModelSubmenu'

const preferencesMock = vi.hoisted(() => ({
  data: {
    default_provider: null as string | null,
    custom_cli_profiles: [] as {
      name: string
      settings_json: string
    }[],
  },
}))

class ResizeObserverMock {
  observe() {
    return undefined
  }
  unobserve() {
    return undefined
  }
  disconnect() {
    return undefined
  }
}

globalThis.ResizeObserver =
  ResizeObserverMock as unknown as typeof ResizeObserver
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView = vi.fn()
}

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    installedBackends: ['claude', 'codex', 'opencode', 'cursor'],
    isLoading: false,
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: ['openai/gpt-5.4'] }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({
    data: [{ id: 'composer-2', label: 'Composer 2' }],
  }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: preferencesMock.data,
  }),
}))

function findModelItem(model: string) {
  const item = screen
    .getAllByRole('menuitem')
    .find(menuItem => within(menuItem).queryByText(model))
  expect(item).toBeDefined()
  return item as HTMLElement
}

function renderMenu(onSelect = vi.fn()) {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <ApprovalModelSubmenu onSelect={onSelect} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return onSelect
}

beforeEach(() => {
  preferencesMock.data = {
    default_provider: null,
    custom_cli_profiles: [],
  }

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('ApprovalModelSubmenu', () => {
  it('renders other model choices grouped by installed backend', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.hover(screen.getByRole('menuitem', { name: /other model/i }))
    await waitFor(() => expect(screen.getByText('Claude')).toBeInTheDocument())

    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('Cursor')).toBeInTheDocument()
  })

  it('filters the model list from a search input at the top', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.hover(screen.getByRole('menuitem', { name: /other model/i }))
    const searchInput = await screen.findByPlaceholderText(/search models/i)

    await user.type(searchInput, 'composer')

    expect(
      screen.getByRole('menuitem', { name: /Composer 2/ })
    ).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /GPT 5\.5/ })).toBeNull()
    expect(screen.queryByText('Claude')).toBeNull()
    expect(screen.queryByText('Codex')).toBeNull()
    expect(screen.queryByText('Cursor')).toBeInTheDocument()
  })

  it('shows an empty state when the search has no model matches', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.hover(screen.getByRole('menuitem', { name: /other model/i }))
    const searchInput = await screen.findByPlaceholderText(/search models/i)

    await user.type(searchInput, 'no-such-model')

    expect(screen.getByText('No models found.')).toBeInTheDocument()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  it('selecting Codex/OpenCode/Cursor models calls callback with one-shot override', async () => {
    const user = userEvent.setup()
    const onSelect = renderMenu()

    await user.hover(screen.getByRole('menuitem', { name: /other model/i }))
    await waitFor(() => expect(screen.getByText('Codex')).toBeInTheDocument())

    fireEvent.click(findModelItem('gpt-5.4'))
    fireEvent.click(findModelItem('openai/gpt-5.4'))
    fireEvent.click(findModelItem('cursor/composer-2'))

    expect(onSelect).toHaveBeenCalledWith({
      backend: 'codex',
      model: 'gpt-5.4',
    })
    expect(onSelect).toHaveBeenCalledWith({
      backend: 'opencode',
      model: 'openai/gpt-5.4',
    })
    expect(onSelect).toHaveBeenCalledWith({
      backend: 'cursor',
      model: 'cursor/composer-2',
    })
  })

  it('resolves Claude labels from custom provider settings_json and selects one-shot aliases', async () => {
    const user = userEvent.setup()
    preferencesMock.data = {
      default_provider: 'OpenRouter',
      custom_cli_profiles: [
        {
          name: 'OpenRouter',
          settings_json: JSON.stringify({
            env: {
              ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-4.8',
              ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6',
              ANTHROPIC_MODEL: 'anthropic/claude-haiku-4.5',
            },
          }),
        },
      ],
    }
    const onSelect = renderMenu()

    await user.hover(screen.getByRole('menuitem', { name: /other model/i }))
    await waitFor(() => expect(screen.getByText('Claude')).toBeInTheDocument())

    expect(
      screen.getByText('Opus (anthropic/claude-opus-4.8)')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Sonnet (anthropic/claude-sonnet-4.6)')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Haiku (anthropic/claude-haiku-4.5)')
    ).toBeInTheDocument()

    fireEvent.click(findModelItem('Sonnet (anthropic/claude-sonnet-4.6)'))

    expect(onSelect).toHaveBeenCalledWith({
      backend: 'claude',
      model: 'sonnet',
    })
  })

  it('falls back to short Claude aliases when custom provider settings_json is invalid', async () => {
    const user = userEvent.setup()
    preferencesMock.data = {
      default_provider: 'BrokenProvider',
      custom_cli_profiles: [
        {
          name: 'BrokenProvider',
          settings_json: '{not valid json',
        },
      ],
    }
    const onSelect = renderMenu()

    await user.hover(screen.getByRole('menuitem', { name: /other model/i }))
    await waitFor(() => expect(screen.getByText('Claude')).toBeInTheDocument())

    expect(screen.getByText('Opus')).toBeInTheDocument()
    expect(screen.getByText('Sonnet')).toBeInTheDocument()
    expect(screen.getByText('Haiku')).toBeInTheDocument()
    expect(screen.queryByText(/anthropic\/claude/)).toBeNull()

    fireEvent.click(findModelItem('Haiku'))

    expect(onSelect).toHaveBeenCalledWith({
      backend: 'claude',
      model: 'haiku',
    })
  })
})
