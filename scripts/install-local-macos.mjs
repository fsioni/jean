#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const logPath = resolve(root, 'tmp/install-local-macos.log')
const childFlag = '--install-child'

export function buildInstallPlan({ universal = false } = {}) {
  return {
    buildCommand: universal
      ? ['bun', ['run', 'tauri:build:macos']]
      : ['bun', ['run', 'tauri:build:fast']],
    installAppPath: '/Applications/Jean.app',
    reopenAppName: 'Jean',
  }
}

export function latestDmg(files) {
  if (files.length === 0) return null
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)[0].path
}

export function parseMountedVolume(output) {
  const line = output.split('\n').find(value => value.includes('/Volumes/'))
  return line?.match(/\/Volumes\/.+$/)?.[0] ?? null
}

export function isAppRunningOutput(output) {
  return output.trim() === 'true'
}

export function shouldStartBackground({ args }) {
  return !args.includes('--foreground') && !args.includes(childFlag)
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })

  if (result.status !== 0) {
    const details = result.stderr || result.stdout || ''
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${details}`)
  }

  return result.stdout ?? ''
}

function findDmgs(dir) {
  if (!existsSync(dir)) return []

  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return findDmgs(path)
    if (!entry.isFile() || !entry.name.endsWith('.dmg')) return []
    return [{ path, mtimeMs: statSync(path).mtimeMs }]
  })
}

function waitForAppToQuit(appName) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = run(
      'osascript',
      ['-e', `tell application "System Events" to exists process "${appName}"`],
      { capture: true }
    )
    if (!isAppRunningOutput(output)) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }

  throw new Error(`${appName} did not quit within 20 seconds.`)
}

function startBackground(args) {
  mkdirSync(dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'a')
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), childFlag, ...args],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    }
  )
  child.unref()
  console.log(`Installing Jean in the background. Log: ${logPath}`)
}

function usage() {
  console.log(`Usage: bun run install:local [-- --foreground] [-- --universal]

Builds a local Jean DMG, quits Jean after the build succeeds, installs it to
/Applications, detaches the DMG, and reopens Jean.

Options:
  --foreground  Run in this terminal instead of detaching
  --universal   Build universal Apple Silicon + Intel macOS DMG
`)
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('This installer only works on macOS.')
  }

  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    usage()
    return
  }

  const universal = args.includes('--universal')

  if (shouldStartBackground({ args })) {
    startBackground(
      args.filter(arg => arg !== '--foreground' && arg !== childFlag)
    )
    return
  }

  const plan = buildInstallPlan({ universal })
  console.log(`Writing progress to ${logPath}`)

  const [buildCommand, buildArgs] = plan.buildCommand
  run(buildCommand, buildArgs)

  const dmg = latestDmg(findDmgs(resolve(root, 'src-tauri/target')))
  if (!dmg) throw new Error('No DMG found under src-tauri/target after build.')
  console.log(`Using DMG: ${dmg}`)

  const attachOutput = run('hdiutil', ['attach', dmg, '-nobrowse'], {
    capture: true,
  })
  const volume = parseMountedVolume(attachOutput)
  if (!volume)
    throw new Error(`Could not find mounted volume in:\n${attachOutput}`)

  const runningOutput = run(
    'osascript',
    [
      '-e',
      `tell application "System Events" to exists process "${plan.reopenAppName}"`,
    ],
    { capture: true }
  )
  if (isAppRunningOutput(runningOutput)) {
    run('osascript', ['-e', `quit app "${plan.reopenAppName}"`], {
      capture: true,
    })
    waitForAppToQuit(plan.reopenAppName)
  }

  try {
    run('ditto', [`${volume}/Jean.app`, plan.installAppPath])
  } finally {
    run('hdiutil', ['detach', volume])
  }

  run('open', ['-a', plan.reopenAppName])
  console.log('Jean has been installed and reopened.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
