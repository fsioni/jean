import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { DesktopBackendModelPicker } from './DesktopBackendModelPicker'

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

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
HTMLCanvasElement.prototype.getContext = vi.fn(() => null)
Element.prototype.scrollIntoView = vi.fn()

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({
    data: ['openai/gpt-5.4', 'groq/compound-mini'],
  }),
}))

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

describe('DesktopBackendModelPicker', () => {
  it('opens picker, lists backend tabs, and selects a model from another backend', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onBackendModelChange = vi.fn()

    render(
      <DesktopBackendModelPicker
        selectedBackend="opencode"
        selectedModel="openai/gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={onBackendModelChange}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /choose backend and model/i })
    )

    const popoverContent = await screen.findByRole('tab', { name: 'Codex' })
    const list = popoverContent.closest('[data-slot="popover-content"]')
    expect(list).not.toBeNull()

    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'Claude' })
    ).toBeInTheDocument()
    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'Codex' })
    ).toBeInTheDocument()
    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'OpenCode' })
    ).toBeInTheDocument()

    await user.click(
      within(list as HTMLElement).getByRole('tab', { name: 'Codex' })
    )
    await user.click(within(list as HTMLElement).getByText('GPT 5.4'))

    expect(onBackendModelChange).toHaveBeenCalledWith('codex', 'gpt-5.4')
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it('searches within the active backend and changes the model in-place', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    const onBackendModelChange = vi.fn()

    render(
      <DesktopBackendModelPicker
        selectedBackend="codex"
        selectedModel="gpt-5.3"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={onModelChange}
        onBackendModelChange={onBackendModelChange}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /choose backend and model/i })
    )

    const searchInput = await screen.findByPlaceholderText(
      /search codex models/i
    )
    await user.type(searchInput, 'gpt 5.4')
    await user.click(screen.getByText('GPT 5.4'))

    expect(onModelChange).toHaveBeenCalledWith('gpt-5.4')
    expect(onBackendModelChange).not.toHaveBeenCalled()
  })

  it('disables non-selected backend tabs while a session has messages', async () => {
    const user = userEvent.setup()

    render(
      <DesktopBackendModelPicker
        sessionHasMessages
        selectedBackend="codex"
        selectedModel="gpt-5.4"
        selectedProvider={null}
        installedBackends={['claude', 'codex', 'opencode']}
        customCliProfiles={[]}
        onModelChange={vi.fn()}
        onBackendModelChange={vi.fn()}
      />
    )

    await user.click(
      screen.getByRole('button', { name: /choose backend and model/i })
    )

    const codexTab = await screen.findByRole('tab', { name: 'Codex' })
    const list = codexTab.closest('[data-slot="popover-content"]')

    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'Claude' })
    ).toBeDisabled()
    expect(codexTab).not.toBeDisabled()
    expect(
      within(list as HTMLElement).getByRole('tab', { name: 'OpenCode' })
    ).toBeDisabled()
  })
})
