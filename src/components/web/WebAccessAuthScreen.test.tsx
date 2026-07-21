import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { WebAccessAuthScreen } from './WebAccessAuthScreen'

describe('WebAccessAuthScreen', () => {
  it('lets the user submit an access token from the browser UI', async () => {
    const onTokenSubmit = vi.fn()

    render(
      <WebAccessAuthScreen
        authError="No access token provided."
        onTokenSubmit={onTokenSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText(/access token/i), {
      target: { value: 'secret-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: /connect/i }))

    expect(onTokenSubmit).toHaveBeenCalledWith('secret-token')
  })

  it('does not submit blank tokens', async () => {
    const onTokenSubmit = vi.fn()

    render(
      <WebAccessAuthScreen
        authError="No access token provided."
        onTokenSubmit={onTokenSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText(/access token/i), {
      target: { value: '   ' },
    })
    fireEvent.click(screen.getByRole('button', { name: /connect/i }))

    expect(onTokenSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/enter the access token/i)).toBeInTheDocument()
  })
})
