import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web connecting overlay', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('blurs the app behind the title-bar connection status', () => {
    expect(source).toContain('!isNativeApp() && !wsConnected')
    expect(source).toContain('backdrop-blur-md')
    expect(source).toContain('pointer-events-auto')
  })

  it('renders a loading indicator in the screen center', () => {
    expect(source).toContain('size-8 animate-spin')
    expect(source).toContain('items-center justify-center')
    expect(source).toContain('Jean is loading...')
  })
})
