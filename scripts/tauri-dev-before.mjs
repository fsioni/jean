#!/usr/bin/env bun
// Cross-platform beforeDevCommand dispatcher.
// - Windows native: just runs `bun run dev` (skips the web-access dist watcher,
//   which requires Linux-native rollup binaries when invoked via WSL bash).
// - Other platforms: delegates to scripts/tauri-dev-with-web-access.sh.

import { spawn } from 'node:child_process'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

const isWindows = process.platform === 'win32'

const child = isWindows
  ? spawn('bun', ['run', 'dev'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true,
    })
  : spawn('bash', ['scripts/tauri-dev-with-web-access.sh'], {
      cwd: rootDir,
      stdio: 'inherit',
    })

const forward = signal => () => {
  if (!child.killed) child.kill(signal)
}
process.on('SIGINT', forward('SIGINT'))
process.on('SIGTERM', forward('SIGTERM'))

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
