import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { ReviewMethodModal } from './ReviewMethodModal'

vi.mock('@/services/coderabbit-cli', () => ({
  useCodeRabbitCliStatus: () => ({
    data: { installed: true, path: '/usr/local/bin/coderabbit' },
    isLoading: false,
  }),
}))

const noop = vi.fn()

describe('ReviewMethodModal', () => {
  it('shows option descriptions without truncation', () => {
    render(
      <ReviewMethodModal
        open
        onOpenChange={noop}
        onAiReview={noop}
        onCodeRabbitCliReview={noop}
        onCodeRabbitPrReview={noop}
        codeRabbitPrAvailable
      />
    )

    const jeanDescription = screen.getByText(
      'Uses your configured review backend'
    )
    const codeRabbitDescription = screen.getByText(
      'Trigger via CLI or PR comment'
    )

    expect(jeanDescription).toBeInTheDocument()
    expect(jeanDescription).not.toHaveClass('truncate')
    expect(codeRabbitDescription).toBeInTheDocument()
    expect(codeRabbitDescription).not.toHaveClass('truncate')
  })
})
