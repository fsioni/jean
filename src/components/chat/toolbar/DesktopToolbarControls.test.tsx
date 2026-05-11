import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { ComponentProps } from 'react'
import { DesktopToolbarControls } from './DesktopToolbarControls'

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

vi.mock('@/lib/platform', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/platform')>('@/lib/platform') // eslint-disable-line @typescript-eslint/consistent-type-imports

  return {
    ...actual,
    openExternal: vi.fn(),
  }
})

type DesktopToolbarControlsProps = ComponentProps<typeof DesktopToolbarControls>

function renderDesktopToolbarControls(
  props: Partial<DesktopToolbarControlsProps> = {}
) {
  const defaultProps: DesktopToolbarControlsProps = {
    hasPendingQuestions: false,
    selectedBackend: 'codex',
    selectedModel: 'gpt-5.4',
    selectedProvider: null,
    selectedThinkingLevel: 'think',
    selectedEffortLevel: 'medium',
    executionMode: 'plan',
    useAdaptiveThinking: false,
    hideThinkingLevel: false,
    sessionHasMessages: false,
    providerLocked: false,
    customCliProfiles: [],
    isCodex: true,
    prUrl: undefined,
    prNumber: undefined,
    displayStatus: undefined,
    checkStatus: undefined,
    mergeableStatus: undefined,
    activeWorktreePath: undefined,
    availableMcpServers: [],
    enabledMcpServers: [],
    activeMcpCount: 0,
    isHealthChecking: false,
    mcpStatuses: undefined,
    loadedIssueContexts: [],
    loadedPRContexts: [],
    loadedSecurityContexts: [],
    loadedAdvisoryContexts: [],
    loadedLinearContexts: [],
    attachedSavedContexts: [],
    providerDropdownOpen: false,
    thinkingDropdownOpen: false,
    mcpDropdownOpen: false,
    setProviderDropdownOpen: vi.fn(),
    setThinkingDropdownOpen: vi.fn(),
    onMcpDropdownOpenChange: vi.fn(),
    onOpenMagicModal: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onResolvePrConflicts: vi.fn(),
    onLoadContext: vi.fn(),
    onAttach: vi.fn(),
    installedBackends: ['claude', 'codex', 'opencode'],
    onSetExecutionMode: vi.fn(),
    availableExecutionModes: ['plan', 'build', 'yolo'],
    onToggleMcpServer: vi.fn(),
    handleModelChange: vi.fn(),
    handleBackendModelChange: vi.fn(),
    handleProviderChange: vi.fn(),
    handleThinkingLevelChange: vi.fn(),
    handleEffortLevelChange: vi.fn(),
    handleViewIssue: vi.fn(),
    handleViewPR: vi.fn(),
    handleViewSecurityAlert: vi.fn(),
    handleViewAdvisory: vi.fn(),
    handleViewLinear: vi.fn(),
    handleViewSavedContext: vi.fn(),
  }

  return render(<DesktopToolbarControls {...defaultProps} {...props} />)
}

describe('DesktopToolbarControls', () => {
  it.each([
    ['plan', 'Plan'],
    ['build', 'Build'],
    ['yolo', 'Yolo'],
  ] as const)('shows %s label in the desktop mode trigger', (mode, label) => {
    renderDesktopToolbarControls({ executionMode: mode })

    expect(
      screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })
    ).toBeInTheDocument()
  })

  it('keeps mode options selectable from the dropdown', async () => {
    const user = userEvent.setup()
    const onSetExecutionMode = vi.fn()

    renderDesktopToolbarControls({
      executionMode: 'plan',
      onSetExecutionMode,
    })

    await user.click(screen.getByRole('button', { name: /^plan$/i }))
    await user.click(
      await screen.findByRole('menuitemradio', { name: /build/i })
    )

    expect(onSetExecutionMode).toHaveBeenCalledWith('build')
  })

  it('hides Claude-only Max effort for Codex', () => {
    renderDesktopToolbarControls({
      isCodex: true,
      selectedBackend: 'codex',
      useAdaptiveThinking: false,
      selectedEffortLevel: 'max',
      thinkingDropdownOpen: true,
    })

    expect(screen.getByText('xHigh')).toBeInTheDocument()
    expect(screen.queryByText('Max')).not.toBeInTheDocument()
  })

  it('keeps Max effort available for Claude adaptive thinking', () => {
    renderDesktopToolbarControls({
      isCodex: false,
      selectedBackend: 'claude',
      useAdaptiveThinking: true,
      selectedEffortLevel: 'max',
      thinkingDropdownOpen: true,
    })

    expect(screen.getAllByText('Max').length).toBeGreaterThan(0)
  })
})
