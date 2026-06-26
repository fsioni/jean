import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GeneralPane settings structure', () => {
  it('renders the OpenCode auto-steer toggle inside OpenCode settings', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const opencodeSection = source.slice(
      source.indexOf("{scope === 'opencode' && ("),
      source.indexOf("{scope === 'cursor' && (")
    )

    expect(opencodeSection).toContain('opencode_auto_steer_enabled')
    expect(opencodeSection).toContain('handleOpenCodeAutoSteerToggle')
  })

  it('does not render a standalone Grok auth check button', () => {
    const source = readFileSync(
      'src/components/preferences/panes/GeneralPane.tsx',
      'utf8'
    )
    const grokSection = source.slice(
      source.indexOf("{scope === 'grok' && ("),
      source.indexOf('{isGeneralScope && (')
    )

    expect(grokSection).not.toContain('Check auth')
    expect(grokSection).not.toContain('grokCliQueryKeys.auth()')
  })
})
