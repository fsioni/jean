import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/skills', () => ({
  useAllBackendSkills: () => [],
}))

vi.mock('@/components/ui/backend-label', () => ({
  getBackendLabel: (backend: string) => (backend === 'grok' ? 'Grok' : backend),
}))

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
Element.prototype.scrollIntoView = vi.fn()

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  onSelectSkill: vi.fn(),
  onSelectCommand: vi.fn(),
  searchQuery: 'goal',
  anchorPosition: { top: 0, left: 0 },
  isAtPromptStart: true,
}

describe('SlashPopover /goal built-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows /goal for Grok sessions', async () => {
    const { SlashPopover } = await import('./SlashPopover')

    render(<SlashPopover {...baseProps} sessionBackend="grok" />)

    expect(screen.getByText('/goal')).toBeInTheDocument()
    expect(screen.getByText('Grok Commands')).toBeInTheDocument()
  })
})
