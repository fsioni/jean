/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ExitPlanModeButton } from './ExitPlanModeButton'
import type { ToolCall } from '@/types/chat'
import type * as DropdownMenuModule from '@/components/ui/dropdown-menu'

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

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    installedBackends: ['claude', 'codex'],
    isLoading: false,
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: [] }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({ data: [] }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      yolo_backend: 'codex',
      yolo_model: 'gpt-5.5',
      selected_codex_model: 'gpt-5.5',
      default_backend: 'claude',
    },
  }),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: (
    selector: (state: { selectedBackends: Record<string, string> }) => unknown
  ) => selector({ selectedBackends: {} }),
}))

vi.mock('./ApprovalModelSubmenu', async () => {
  const { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } =
    await vi.importActual<typeof DropdownMenuModule>(
      '@/components/ui/dropdown-menu'
    )

  return {
    ApprovalActionGroup: ({
      title,
      defaultModelLabel,
      separatorBefore,
      onDefaultSelect,
      onModelSelect,
    }: {
      title: string
      defaultModelLabel?: string | null
      separatorBefore?: boolean
      onDefaultSelect: () => void
      onModelSelect: (override: { backend: string; model: string }) => void
    }) => (
      <>
        {separatorBefore && <DropdownMenuSeparator />}
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        <DropdownMenuItem onClick={onDefaultSelect}>
          <span>{defaultModelLabel ?? 'Current default'}</span>
          <span>(use default)</span>
        </DropdownMenuItem>
        <div role="menuitem">Other model…</div>
        <DropdownMenuItem
          onClick={() => onModelSelect({ backend: 'codex', model: 'gpt-5.5' })}
        >
          Codex · GPT 5.5
        </DropdownMenuItem>
      </>
    ),
  }
})

const planToolCalls: ToolCall[] = [
  {
    id: 'plan-1',
    name: 'CodexPlan',
    input: { plan_preview: 'Plan' },
  },
]

beforeEach(() => {
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

describe('ExitPlanModeButton', () => {
  it('groups yolo new-session and new-worktree model choices under titled sections', async () => {
    const user = userEvent.setup()
    const onClearContextApproval = vi.fn()
    const onWorktreeYoloApproval = vi.fn()

    render(
      <ExitPlanModeButton
        toolCalls={planToolCalls}
        isApproved={false}
        onPlanApproval={vi.fn()}
        onPlanApprovalYolo={vi.fn()}
        onClearContextApproval={onClearContextApproval}
        onWorktreeYoloApproval={onWorktreeYoloApproval}
        sessionId="session-1"
      />
    )

    const yoloChevron = screen.getAllByRole('button', { name: '' }).at(-1)
    expect(yoloChevron).toBeDefined()
    const openYoloMenu = async () => {
      await user.click(yoloChevron as HTMLElement)
    }

    await openYoloMenu()

    expect(screen.getByText('New Session (YOLO)')).toBeInTheDocument()
    expect(screen.getByText('New Worktree (YOLO)')).toBeInTheDocument()
    expect(screen.queryByText('New Session (YOLO): Other model…')).toBeNull()
    expect(screen.queryByText('New Worktree (YOLO): Other model…')).toBeNull()

    const groups = screen.getAllByText(/New (Session|Worktree) \(YOLO\)/)
    expect(groups).toHaveLength(2)
    expect(
      screen.getAllByRole('menuitem', { name: /Other model/i })
    ).toHaveLength(2)
    expect(
      screen.getAllByRole('menuitem', { name: /^Codex · GPT 5\.5$/i })
    ).toHaveLength(2)
    expect(screen.getAllByText('(use default)')).toHaveLength(2)
    expect(
      screen.getAllByRole('menuitem', { name: /\(use default\)/i })
    ).toHaveLength(2)

    await user.click(
      screen.getAllByRole('menuitem', { name: /\(use default\)/i })[0]
    )
    expect(onClearContextApproval).toHaveBeenCalledWith()

    await openYoloMenu()
    await user.click(
      screen.getAllByRole('menuitem', { name: /\(use default\)/i })[1]
    )
    expect(onWorktreeYoloApproval).toHaveBeenCalledWith()

    await openYoloMenu()
    await user.click(
      screen.getAllByRole('menuitem', { name: /Other model/i })[0]
    )
    await user.click(
      screen.getAllByRole('menuitem', { name: /^Codex · GPT 5\.5$/i })[0]
    )
    expect(onClearContextApproval).toHaveBeenCalledWith({
      backend: 'codex',
      model: 'gpt-5.5',
    })

    await openYoloMenu()
    await user.click(
      screen.getAllByRole('menuitem', { name: /Other model/i })[1]
    )
    await user.click(
      screen.getAllByRole('menuitem', { name: /^Codex · GPT 5\.5$/i })[1]
    )
    expect(onWorktreeYoloApproval).toHaveBeenCalledWith({
      backend: 'codex',
      model: 'gpt-5.5',
    })
  })
})
