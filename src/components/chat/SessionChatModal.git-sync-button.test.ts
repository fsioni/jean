import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Issue #774: remote servers can store an old `git_sync_button: false`, so the
// sync badge must follow this client's (local) preference, like the sidebar.
describe('git sync button preference source', () => {
  it.each([
    'src/components/chat/SessionChatModal.tsx',
    'src/components/dashboard/ProjectCanvasView.tsx',
  ])('%s reads git_sync_button from local preferences', file => {
    const source = readFileSync(file, 'utf8')

    expect(source).toContain(
      'const { data: localPreferences } = usePreferences(LOCAL_SERVER_ID)'
    )
    expect(source).toContain('localPreferences?.git_sync_button ?? true')
    expect(source).not.toMatch(/[^l]preferences\?\.git_sync_button/)
  })
})
