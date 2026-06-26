import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GrokIcon } from './GrokIcon'

describe('GrokIcon', () => {
  it('renders the xAI Grok mark instead of the placeholder hexagon', () => {
    render(<GrokIcon data-testid="grok-icon" />)

    const icon = screen.getByTestId('grok-icon')
    const paths = icon.querySelectorAll('path')

    expect(icon).toHaveAttribute('viewBox', '0 0 34 32')
    expect(icon).not.toHaveAttribute('stroke')
    expect(paths).toHaveLength(2)
    expect(paths[0]).toHaveAttribute(
      'd',
      'M13.374 20.5407L24.4555 12.3506C24.9988 11.9491 25.7753 12.1057 26.0342 12.7294C27.3966 16.0185 26.7879 19.9712 24.0772 22.6851C21.3666 25.3989 17.595 25.9941 14.1477 24.6386L10.3818 26.3843C15.7832 30.0806 22.3422 29.1665 26.4409 25.0601C29.692 21.8051 30.6989 17.3683 29.7574 13.3673L29.7659 13.3758C28.4006 7.49809 30.1016 5.14871 33.5859 0.344576C33.6683 0.230667 33.7508 0.116757 33.8333 0L29.2482 4.59055V4.57631L13.3712 20.5436'
    )
    paths.forEach(path => {
      expect(path).toHaveAttribute('fill', 'currentColor')
    })
  })
})
