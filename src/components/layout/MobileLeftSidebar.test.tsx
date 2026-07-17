/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { MobileLeftSidebar } from './MobileLeftSidebar'

vi.mock('./LeftSideBar', () => ({
  LeftSideBar: () => <div data-testid="left-sidebar-content">Sidebar body</div>,
}))

describe('MobileLeftSidebar', () => {
  it('renders as an overlay dialog when open without taking layout flow', async () => {
    const onOpenChange = vi.fn()

    render(
      <div data-testid="layout-root">
        <div data-testid="main-content">Main content stays put</div>
        <MobileLeftSidebar open={true} onOpenChange={onOpenChange} width={250} />
      </div>
    )

    const sheet = await screen.findByTestId('mobile-left-sidebar')
    expect(sheet).toBeInTheDocument()
    expect(await screen.findByTestId('left-sidebar-content')).toBeInTheDocument()

    // Sheet content is portaled (fixed overlay), so main content remains a direct child
    const layoutRoot = screen.getByTestId('layout-root')
    expect(layoutRoot.children).toHaveLength(1)
    expect(screen.getByTestId('main-content')).toBeInTheDocument()
  })

  it('does not render sheet content when closed', () => {
    render(
      <MobileLeftSidebar open={false} onOpenChange={vi.fn()} width={250} />
    )

    expect(screen.queryByTestId('mobile-left-sidebar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('left-sidebar-content')).not.toBeInTheDocument()
  })

  it('closes when the dimmed backdrop (grey area) is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(
      <MobileLeftSidebar open={true} onOpenChange={onOpenChange} width={250} />
    )

    await screen.findByTestId('mobile-left-sidebar')

    const overlay = document.querySelector('[data-slot="sheet-overlay"]')
    expect(overlay).toBeTruthy()

    await user.click(overlay as Element)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
