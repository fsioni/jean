import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildInstallPlan,
  isAppRunningOutput,
  latestDmg,
  parseMountedVolume,
  shouldStartBackground,
} from './install-local-macos.mjs'

test('latestDmg picks the newest dmg by modified time', () => {
  const files = [
    { path: 'old.dmg', mtimeMs: 100 },
    { path: 'new.dmg', mtimeMs: 300 },
    { path: 'middle.dmg', mtimeMs: 200 },
  ]

  assert.equal(latestDmg(files), 'new.dmg')
})

test('parseMountedVolume extracts the /Volumes path from hdiutil output', () => {
  const output = `/dev/disk4           GUID_partition_scheme
/dev/disk4s1         Apple_HFS                       /Volumes/Jean 0.1.59`

  assert.equal(parseMountedVolume(output), '/Volumes/Jean 0.1.59')
})

test('buildInstallPlan defaults to fast build and latest dmg install', () => {
  const plan = buildInstallPlan({ background: false, universal: false })

  assert.deepEqual(plan.buildCommand, ['bun', ['run', 'tauri:build:fast']])
  assert.equal(plan.installAppPath, '/Applications/Jean.app')
  assert.equal(plan.reopenAppName, 'Jean')
})

test('buildInstallPlan uses universal macOS build when requested', () => {
  const plan = buildInstallPlan({ background: false, universal: true })

  assert.deepEqual(plan.buildCommand, ['bun', ['run', 'tauri:build:macos']])
})

test('isAppRunningOutput handles osascript booleans', () => {
  assert.equal(isAppRunningOutput('true\n'), true)
  assert.equal(isAppRunningOutput('false\n'), false)
})

test('shouldStartBackground ignores leaked child env from parent shells', () => {
  assert.equal(
    shouldStartBackground({
      args: [],
      env: { JEAN_INSTALL_BACKGROUND_CHILD: '1' },
    }),
    true
  )
})

test('shouldStartBackground stays foreground for explicit foreground or internal child flag', () => {
  assert.equal(
    shouldStartBackground({ args: ['--foreground'], env: {} }),
    false
  )
  assert.equal(
    shouldStartBackground({ args: ['--install-child'], env: {} }),
    false
  )
})
