import assert from 'node:assert/strict'
import { readFileSync, accessSync, constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = resolve(root, 'scripts/install-jean-server.sh')

test('install-jean-server.sh is executable and bash-clean', () => {
  accessSync(script, constants.X_OK)
  const syntax = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('install-jean-server.sh help documents core options', () => {
  const result = spawnSync('bash', [script, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--host/)
  assert.match(result.stdout, /--port/)
  assert.match(result.stdout, /--token/)
  assert.match(result.stdout, /--user-install/)
  assert.match(result.stdout, /--uninstall/)
  assert.match(result.stdout, /systemd/)
})

test('install-jean-server.sh script covers download, verify, systemd, env file', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /jean-server-linux-\$\{ARCH\}|jean-server-\$\{ASSET_ARCH\}/)
  assert.match(source, /sha256|Checksum/)
  assert.match(source, /systemctl/)
  assert.match(source, /EnvironmentFile/)
  assert.match(source, /JEAN_TOKEN/)
  assert.match(source, /JEAN_HOST/)
  assert.match(source, /JEAN_PORT/)
  assert.match(source, /openrc/i)
  assert.match(source, /atomic_install_binary|mv -f/)
  assert.match(source, /--user-install/)
  assert.match(source, /--uninstall/)
})

test('install-jean-server.sh refuses public bind without token', () => {
  const source = readFileSync(script, 'utf8')
  assert.match(source, /Refusing --no-token with public bind host/)
})
