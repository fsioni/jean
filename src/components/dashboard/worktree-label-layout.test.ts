import { describe, expect, it } from 'vitest'

import { getWorktreeLabelContainerClassName } from './worktree-label-layout'

describe('worktree label layout', () => {
  it('uses a mobile secondary row while preserving desktop right alignment', () => {
    const className = getWorktreeLabelContainerClassName()

    expect(className).toContain('w-full')
    expect(className).toContain('justify-start')
    expect(className).toContain('pt-1')
    expect(className).toContain('sm:ml-auto')
    expect(className).toContain('sm:w-auto')
    expect(className).toContain('sm:max-w-[45%]')
    expect(className).toContain('sm:justify-end')
    expect(className).toContain('sm:pt-0')
  })
})
