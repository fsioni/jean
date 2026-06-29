import { describe, expect, it } from 'vitest'
import { setServerPlatform } from './platform'
import { escapeCliCommand } from './shell-escape'

describe('escapeCliCommand', () => {
  it('uses the Jean server platform instead of the browser user agent', () => {
    setServerPlatform('linux')

    expect(escapeCliCommand('/home/me/my cli', '--help')).toBe(
      "'/home/me/my cli' --help"
    )

    setServerPlatform('windows')
    expect(escapeCliCommand('C:\\Tools\\my cli.exe', '--help')).toBe(
      '& "C:\\Tools\\my cli.exe" --help'
    )
  })
})
