import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { Zap } from 'lucide-react'
import { fireEvent, render, screen } from '@/test/test-utils'
import { MobileSettingsMenu } from './MobileSettingsMenu'
import * as platform from '@/lib/platform'

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

const baseProps = {
  isDisabled: false,
  selectedBackend: 'claude' as const,
  selectedProvider: null,
  backendModelLabel: 'Claude · Sonnet',
  backendModelLabelText: 'Claude · Sonnet',
  hasMultipleBackendModelChoices: true,
  selectedEffortLevel: 'medium' as const,
  selectedThinkingLevel: 'think' as const,
  useAdaptiveThinking: false,
  isCodex: false,
  customCliProfiles: [],
  onOpenBackendModelPicker: vi.fn(),
  handleProviderChange: vi.fn(),
  handleEffortLevelChange: vi.fn(),
  handleThinkingLevelChange: vi.fn(),
  loadedIssueContexts: [],
  loadedPRContexts: [],
  loadedSecurityContexts: [],
  loadedAdvisoryContexts: [],
  loadedLinearContexts: [],
  attachedSavedContexts: [],
  handleViewIssue: vi.fn(),
  handleViewPR: vi.fn(),
  handleViewSecurityAlert: vi.fn(),
  handleViewAdvisory: vi.fn(),
  handleViewLinear: vi.fn(),
  handleViewSavedContext: vi.fn(),
  availableMcpServers: [],
  enabledMcpServers: [],
  activeMcpCount: 0,
  onToggleMcpServer: vi.fn(),
}

describe('MobileSettingsMenu', () => {
  it('hides model row chevron when there is only one backend/model choice', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        hasMultipleBackendModelChoices={false}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    const modelItem = screen.getByText('Model').closest('[role="menuitem"]')
    expect(modelItem?.querySelector('svg.lucide-chevron-right')).toBeNull()
  })

  it('shows MCP as a plain disabled row when no servers are configured', async () => {
    const user = userEvent.setup()

    render(<MobileSettingsMenu {...baseProps} availableMcpServers={[]} />)

    await user.click(screen.getByRole('button', { name: /settings/i }))

    const mcpItem = screen.getByText('MCP').closest('[role="menuitem"]')
    expect(mcpItem).toHaveAttribute('aria-disabled', 'true')
    expect(mcpItem?.querySelector('svg.lucide-chevron-right')).toBeNull()
    expect(screen.getByText('None')).toBeInTheDocument()
  })

  it('opens backend/model picker via gear menu', async () => {
    const user = userEvent.setup()
    const onOpenBackendModelPicker = vi.fn()

    render(
      <MobileSettingsMenu
        {...baseProps}
        onOpenBackendModelPicker={onOpenBackendModelPicker}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()

    await user.click(screen.getByText('Model'))
    expect(onOpenBackendModelPicker).toHaveBeenCalledTimes(1)
  })

  it('keeps model settings usable while a session is running', async () => {
    const user = userEvent.setup()
    const onOpenBackendModelPicker = vi.fn()

    render(
      <MobileSettingsMenu
        {...baseProps}
        isDisabled={false}
        onOpenBackendModelPicker={onOpenBackendModelPicker}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Model'))

    expect(onOpenBackendModelPicker).toHaveBeenCalledTimes(1)
  })

  it('shows fast mode icon in the model row label', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        backendModelLabel={
          <>
            Codex · GPT 5.5
            <Zap aria-label="Fast mode" />
          </>
        }
        backendModelLabelText="Codex · GPT 5.5"
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByLabelText('Fast mode')).toBeInTheDocument()
  })

  it('renders worktree PR row when prUrl + prNumber set; click opens externally', async () => {
    const user = userEvent.setup()
    const openSpy = vi
      .spyOn(platform, 'openExternal')
      .mockImplementation(() => {
        return undefined as unknown as ReturnType<typeof platform.openExternal>
      })

    render(
      <MobileSettingsMenu
        {...baseProps}
        prUrl="https://github.com/owner/repo/pull/9999"
        prNumber={9999}
        prDisplayStatus="open"
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Linked')).toBeInTheDocument()
    expect(screen.getByText('PR #9999')).toBeInTheDocument()

    await user.click(screen.getByText('PR #9999'))
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/owner/repo/pull/9999'
    )

    openSpy.mockRestore()
  })

  it('hides Linked section when no PR data set', async () => {
    const user = userEvent.setup()

    render(<MobileSettingsMenu {...baseProps} />)

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.queryByText('Linked')).not.toBeInTheDocument()
  })

  it('hides reasoning control for Command Code in mobile settings', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedBackend="commandcode"
        backendModelLabel="Command Code · CLI default"
        backendModelLabelText="Command Code · CLI default"
        useAdaptiveThinking={false}
        isCodex={false}
        hideThinkingLevel={false}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Effort')).not.toBeInTheDocument()
  })

  it('hides Claude-only Max and Ultracode effort for Codex', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedBackend="codex"
        backendModelLabel="Codex · GPT 5.5"
        backendModelLabelText="Codex · GPT 5.5"
        selectedEffortLevel="max"
        useAdaptiveThinking={false}
        isCodex
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))

    expect(screen.getByText('xHigh')).toBeInTheDocument()
    expect(screen.queryByText('Max')).not.toBeInTheDocument()
    expect(screen.queryByText('Ultracode')).not.toBeInTheDocument()
  })

  it('shows PI effort options instead of Claude thinking in mobile settings', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedBackend="pi"
        backendModelLabel="PI · GPT 5.5 (OpenAI Codex)"
        backendModelLabelText="PI · GPT 5.5 (OpenAI Codex)"
        selectedEffortLevel="xhigh"
        selectedThinkingLevel="megathink"
        useAdaptiveThinking={false}
        isCodex={false}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))

    expect(screen.getByText('Effort')).toBeInTheDocument()
    expect(screen.getByText('xHigh')).toBeInTheDocument()
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Megathink')).not.toBeInTheDocument()

    await user.click(screen.getByText('Effort'))

    expect(
      screen.getByRole('menuitemradio', { name: /minimal/i })
    ).toBeInTheDocument()
    expect(screen.queryByText('Max')).not.toBeInTheDocument()
    expect(screen.queryByText('Ultracode')).not.toBeInTheDocument()
  })

  it('calls effort change handler when selecting an effort on mobile', async () => {
    const user = userEvent.setup()
    const handleEffortLevelChange = vi.fn()

    render(
      <MobileSettingsMenu
        {...baseProps}
        useAdaptiveThinking
        handleEffortLevelChange={handleEffortLevelChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))
    const xHighItem = screen
      .getAllByRole('menuitemradio', { name: /xhigh/i })
      .find(item => item.textContent?.startsWith('xHigh'))
    expect(xHighItem).toBeDefined()
    if (!xHighItem) return
    fireEvent.click(xHighItem)

    expect(handleEffortLevelChange).toHaveBeenCalledWith('xhigh')
  })

  it('keeps Max effort available for Claude adaptive thinking', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedEffortLevel="max"
        useAdaptiveThinking
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))

    expect(screen.getAllByText('Max').length).toBeGreaterThan(0)
  })

  it('keeps Ultracode effort available for Claude adaptive thinking', async () => {
    const user = userEvent.setup()

    render(
      <MobileSettingsMenu
        {...baseProps}
        selectedEffortLevel="ultracode"
        useAdaptiveThinking
      />
    )

    await user.click(screen.getByRole('button', { name: /settings/i }))
    await user.click(screen.getByText('Effort'))

    expect(screen.getAllByText('Ultracode').length).toBeGreaterThan(0)
  })
})
