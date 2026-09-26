import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ProjectsSidebar server filter', () => {
  it('offers Projects and Recent as the two top-level views', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain('role="tablist"')
    expect(source).toContain("(['projects', 'recent'] as const)")
    expect(source).toContain('<RecentWorktreesList')
    expect(source).toContain('footerActionsContainer={footerActionsEl}')
    expect(source).toContain('ref={setFooterActionsEl}')
    expect(source).toContain('state => state.sidebarActiveTab')
    expect(source).toContain('state => state.setSidebarActiveTab')
  })

  it('uses a compact dropdown that blends into the sidebar', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain('className="px-3 py-2"')
    expect(source).toContain('<DropdownMenuTrigger')
    expect(source).toContain('aria-label="Filter projects by server"')
    expect(source).toContain(
      'border-transparent bg-transparent pl-7 pr-2 text-xs shadow-none focus-visible:border-transparent dark:bg-transparent'
    )
    expect(source).not.toContain('<SelectTrigger')
  })

  it('opens Connections from the server dropdown', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain('Connections')
    expect(source).not.toContain('Jean connections')
    expect(source).toContain('setConnectionsOpen(true)')
    expect(source).toContain('<RemoteConnectionsDialog')
  })

  it('does not expose server feature surfaces in the footer', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).not.toContain('ServerFeatureSurfaces')
    expect(source).not.toContain('>Features<')
  })

  it('places quiet creation controls after search and before the project list', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    const serverSelector = source.indexOf(
      'aria-label="Filter projects by server"'
    )
    const search = source.indexOf('aria-label="Search projects and worktrees"')
    const addProject = source.indexOf('aria-label="Add project"')
    const addWorktree = source.indexOf(
      'aria-label="Add worktree to selected project"'
    )
    const projectTree = source.indexOf('<ProjectTree')

    expect(serverSelector).toBeGreaterThan(search)
    expect(addProject).toBeGreaterThan(search)
    expect(addWorktree).toBeGreaterThan(addProject)
    expect(serverSelector).toBeGreaterThan(addWorktree)
    expect(projectTree).toBeGreaterThan(serverSelector)
    expect(source).toContain('<Plus className="size-3.5" />')
    expect(source).toContain('<GitBranchPlus className="size-3.5" />')
    expect(source).toContain('disabled={!selectedProjectId}')
    expect(source).toContain('className="flex gap-1 px-3 pt-2"')
    expect(source).toContain('border-transparent bg-transparent')
    expect(source).toContain('searchQuery={searchQuery}')
    expect(source).not.toContain('aria-label="New"')
    expect(source).not.toContain('{/* Footer')
  })

  it('aligns its divider with the session header divider', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain(
      'className="border-b border-border/40 pb-2 pt-[3px]"'
    )
  })

  it('does not draw dividers between local and remote server sections', () => {
    const source = readFileSync(
      'src/components/projects/ProjectTree.tsx',
      'utf8'
    )

    expect(source).not.toContain('sectionIndex > 0')
  })

  it('places Settings in a bottom sidebar footer', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    const projectTree = source.indexOf('<ProjectTree')
    const settings = source.indexOf('aria-label="Open Settings"')

    expect(settings).toBeGreaterThan(projectTree)
    expect(source).toContain('data-testid="sidebar-settings"')
    expect(source).toContain('togglePreferences()')
  })

  it('adds bottom safe-area spacing to the footer in web access', () => {
    const source = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )

    expect(source).toContain(
      "showServerMenu ? 'p-2' : 'px-2 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]'"
    )
  })

  it('places the app version at the bottom-right of the sidebar footer', () => {
    const sidebar = readFileSync(
      'src/components/projects/ProjectsSidebar.tsx',
      'utf8'
    )
    const titleBar = readFileSync(
      'src/components/titlebar/TitleBar.tsx',
      'utf8'
    )

    expect(sidebar).toContain('data-testid="sidebar-app-version"')
    expect(sidebar).toContain('justify-between')
    expect(sidebar).toContain('v{appVersion}')
    expect(titleBar).not.toContain('v{appVersion}')
  })
})
