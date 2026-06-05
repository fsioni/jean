import { describe, expect, it } from 'vitest'
import { resolveApprovalLabel } from './approval-label-utils'

const prefs = {
  build_model: null,
  build_backend: null,
  yolo_model: 'gpt-5.5',
  yolo_backend: 'codex',
  selected_model: 'claude-opus-4-8[1m]',
  selected_codex_model: 'gpt-5.5',
  selected_opencode_model: 'opencode/gpt-5.3-codex',
  selected_cursor_model: 'cursor/auto',
  default_backend: 'claude',
}

describe('resolveApprovalLabel', () => {
  it('uses yolo backend override for new context labels when forced', () => {
    const label = resolveApprovalLabel('yolo', prefs, 'claude', {
      forceModeOverride: true,
    })

    expect(label).toContain('codex')
    expect(label).toContain('GPT 5.5')
  })

  it('keeps same-session labels on current backend when override backend differs', () => {
    const label = resolveApprovalLabel('yolo', prefs, 'claude')

    expect(label).not.toContain('codex')
    expect(label).toContain('Opus')
  })

  it('uses yolo backend override for same-session labels when backend matches', () => {
    const label = resolveApprovalLabel('yolo', prefs, 'codex')

    expect(label).toContain('codex')
    expect(label).toContain('GPT 5.5')
  })
})
