import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('UI state multi-client sync', () => {
  it('broadcasts saved UI state from the shared native and web save path', () => {
    const source = readFileSync(
      `${process.cwd()}/jean-core/src/lib.rs`,
      'utf8'
    )
    const save = source.match(
      /async fn save_ui_state\([\s\S]*?^async fn send_native_notification/m
    )?.[0]

    expect(save).toContain('app.emit_all(')
    expect(save).toContain('"cache:invalidate"')
    expect(save).toContain('"ui-state"')
  })
})
