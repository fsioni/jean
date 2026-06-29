import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { MessageDiffModal } from './MessageDiffModal'

let tauriAvailable = false

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => tauriAvailable,
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => false,
}))

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: () => <div data-testid="file-diff" />,
}))

const patch = `Index: src/example.ts
===================================================================
--- src/example.ts
+++ src/example.ts
@@ -1,1 +1,2 @@
 const a = 1
+const b = 2
`

describe('MessageDiffModal header', () => {
  beforeEach(() => {
    tauriAvailable = false
  })

  it('shows change stats as text next to the filename, not as a Current change button', async () => {
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={patch}
      />
    )

    expect(await screen.findByText('example.ts')).toBeVisible()
    expect(screen.getByText('+1')).toBeVisible()
    expect(screen.getByText('-0')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /Current change/i })
    ).not.toBeInTheDocument()
  })

  it('does not show an All changes button when native git diff is available', async () => {
    tauriAvailable = true

    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={patch}
      />
    )

    expect(await screen.findByText('example.ts')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /All changes/i })
    ).not.toBeInTheDocument()
  })

  it('keeps the close button anchored to the dialog corner', async () => {
    render(
      <MessageDiffModal
        isOpen
        onClose={vi.fn()}
        filePath="/repo/src/example.ts"
        worktreePath="/repo"
        edits={[]}
        patch={patch}
      />
    )

    const closeButton = await screen.findByRole('button', { name: 'Close' })
    expect(closeButton.className).toContain('absolute')
    expect(closeButton.className).toContain('right-4')
    expect(closeButton.className).toContain('top-4')
  })
})
