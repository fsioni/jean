import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(`${process.cwd()}/${path}`, 'utf8')

const expectProjectActionOrder = (source: string) => {
  const newWorktree = source.indexOf('New Worktree')
  const openBaseSession = source.indexOf('Open Base Session')
  const projectSettings = source.indexOf('Project Settings')
  const removeProject = source.indexOf('Remove Project')

  expect(newWorktree).toBeGreaterThanOrEqual(0)
  expect(openBaseSession).toBeGreaterThan(newWorktree)
  expect(projectSettings).toBeGreaterThan(openBaseSession)
  expect(removeProject).toBeGreaterThan(projectSettings)
  expect(source).not.toContain('closeBaseSession.mutate')
  expect(source).toContain('createBaseSession.mutate')
  expect(source).toContain("'New Base Session'")
}

describe('project action menus', () => {
  it('orders the canvas menu from creation actions to project management', () => {
    const source = readSource('src/components/dashboard/ProjectCanvasView.tsx')
    const menu = source.slice(
      source.indexOf('aria-label="Project actions"'),
      source.indexOf('aria-label="Sort worktrees"')
    )

    expectProjectActionOrder(menu)
  })

  it('keeps the sidebar context menu in the same order', () => {
    expectProjectActionOrder(
      readSource('src/components/projects/ProjectContextMenu.tsx')
    )
  })
})
