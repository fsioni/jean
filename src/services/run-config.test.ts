import { describe, expect, it } from 'vitest'
import { normalizeRunScriptEntries } from './projects'

describe('Run configuration', () => {
  it('keeps legacy scripts compatible', () => {
    expect(normalizeRunScriptEntries('bun dev')).toEqual([
      {
        id: 'default',
        label: 'bun dev',
        command: 'bun dev',
        isDefault: true,
      },
    ])
    expect(normalizeRunScriptEntries(['bun dev', 'bun test'])).toEqual([
      {
        id: 'run-1',
        label: 'bun dev',
        command: 'bun dev',
        isDefault: true,
      },
      {
        id: 'run-2',
        label: 'bun test',
        command: 'bun test',
        isDefault: false,
      },
    ])
  })

  it('normalizes named scripts and selects the explicit default', () => {
    expect(
      normalizeRunScriptEntries({
        web: { command: 'bun dev', label: 'Web' },
        worker: { command: 'bun worker', default: true },
      })
    ).toEqual([
      {
        id: 'web',
        label: 'Web',
        command: 'bun dev',
        isDefault: false,
      },
      {
        id: 'worker',
        label: 'worker',
        command: 'bun worker',
        isDefault: true,
      },
    ])
  })
})
