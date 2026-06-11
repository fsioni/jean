import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useUIStore } from '@/store/ui-store'
import { ChatSearchBar } from './ChatSearchBar'

function Harness() {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  return (
    <>
      <div ref={scrollContainerRef}>A chat message about search results.</div>
      <ChatSearchBar scrollContainerRef={scrollContainerRef} />
    </>
  )
}

describe('ChatSearchBar', () => {
  beforeEach(() => {
    useUIStore.setState({ chatSearchOpen: true })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 0
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('closes when Escape is pressed from the focused search input', () => {
    render(<Harness />)

    const input = screen.getByPlaceholderText('Find in chat...')
    input.focus()

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(
      screen.queryByPlaceholderText('Find in chat...')
    ).not.toBeInTheDocument()
    expect(useUIStore.getState().chatSearchOpen).toBe(false)
  })

  it('closes when Escape is pressed from any focused search control', () => {
    render(<Harness />)

    const closeButton = screen.getByRole('button', { name: 'Close search' })
    closeButton.focus()

    fireEvent.keyDown(closeButton, { key: 'Escape' })

    expect(
      screen.queryByPlaceholderText('Find in chat...')
    ).not.toBeInTheDocument()
    expect(useUIStore.getState().chatSearchOpen).toBe(false)
  })
})
