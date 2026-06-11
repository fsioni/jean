import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { useExternalLinkInterceptor } from './useExternalLinkInterceptor'
import * as platform from '@/lib/platform'

function Harness() {
  useExternalLinkInterceptor()
  return (
    <div>
      <a href="https://github.com/owner/repo/issues/123">GitHub issue</a>
      <a href="https://github.com/owner/repo/pull/456">GitHub PR</a>
      <a href="#local-section" onClick={event => event.preventDefault()}>
        Local hash
      </a>
      <a href="/internal/path" onClick={event => event.preventDefault()}>
        Internal route
      </a>
      <a href="mailto:test@example.com">Email</a>
    </div>
  )
}

describe('useExternalLinkInterceptor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('routes GitHub issue links through the external opener', async () => {
    const user = userEvent.setup()
    const openSpy = vi.spyOn(platform, 'openExternal').mockResolvedValue()

    render(<Harness />)

    await user.click(screen.getByRole('link', { name: 'GitHub issue' }))

    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/owner/repo/issues/123'
    )
  })

  it('routes GitHub PR links through the external opener', async () => {
    const user = userEvent.setup()
    const openSpy = vi.spyOn(platform, 'openExternal').mockResolvedValue()

    render(<Harness />)

    await user.click(screen.getByRole('link', { name: 'GitHub PR' }))

    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/owner/repo/pull/456'
    )
  })

  it('does not intercept local hash or internal relative links', async () => {
    const user = userEvent.setup()
    const openSpy = vi.spyOn(platform, 'openExternal').mockResolvedValue()

    render(<Harness />)

    await user.click(screen.getByRole('link', { name: 'Local hash' }))
    await user.click(screen.getByRole('link', { name: 'Internal route' }))

    expect(openSpy).not.toHaveBeenCalled()
  })

  it('routes mailto links through the external opener', async () => {
    const user = userEvent.setup()
    const openSpy = vi.spyOn(platform, 'openExternal').mockResolvedValue()

    render(<Harness />)

    await user.click(screen.getByRole('link', { name: 'Email' }))

    expect(openSpy).toHaveBeenCalledWith('mailto:test@example.com')
  })
})
