import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/components/chat/SessionChatModal.tsx', 'utf8')
const headerSource = readFileSync(
  'src/components/ai-pipeline/WorktreeValidationHeader.tsx',
  'utf8'
)
describe('automation inline placement in shared native/web/mobile chat', () => {
  it('places the permanent strip after the title/badges row, before session tabs, within the zen-mode gate', () => {
    const zenGate = source.indexOf(
      '{!zenMode && (',
      source.indexOf(
        '<ModalBrowserDrawer worktreeId={worktreeId} dockMode="left"'
      )
    )
    const titleRowEnd = source.indexOf('</h2>', zenGate)
    const badgeRowEnd = source.indexOf('<ModalCloseButton', titleRowEnd)
    const strip = source.indexOf('<WorktreeValidationHeader', badgeRowEnd)
    const tabs = source.indexOf('{/* Session tabs', strip)
    expect(strip).toBeGreaterThan(badgeRowEnd)
    expect(tabs).toBeGreaterThan(strip)
    expect(source.slice(badgeRowEnd, strip)).toContain(
      '</div>\n              </div>'
    )
    expect(source.slice(strip, tabs)).toContain('</div>\n          )}')
    expect(source.match(/<WorktreeValidationHeader/g)).toHaveLength(1)
  })
  it('uses the shared strip instead of a popup or IA trigger, without a mobile-only gate', () => {
    expect(headerSource).toContain('<WorktreeValidationInline')
    expect(headerSource).not.toMatch(
      /Popover|Dialog|useIsMobile|isNativeApp|<button/
    )
  })
})
