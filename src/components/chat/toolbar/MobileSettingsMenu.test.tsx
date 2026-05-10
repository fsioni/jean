import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { Zap } from 'lucide-react'
import { render, screen } from '@/test/test-utils'
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
    const openSpy = vi.spyOn(platform, 'openExternal').mockImplementation(() => {
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
})
