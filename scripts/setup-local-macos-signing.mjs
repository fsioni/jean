#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const identity = 'Jean Local Signing'
const keychain = join(homedir(), 'Library/Keychains/login.keychain-db')

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options })
}

if (process.platform !== 'darwin') {
  throw new Error('Local Jean signing is only needed on macOS.')
}

const existing = run('/usr/bin/security', [
  'find-identity',
  '-v',
  '-p',
  'codesigning',
])
if (existing.includes(`"${identity}"`)) {
  console.log(`The '${identity}' identity is already installed.`)
  process.exit(0)
}

let openssl
for (const candidate of ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl']) {
  try {
    run(candidate, ['version'], { stdio: 'ignore' })
    openssl = candidate
    break
  } catch {
    // Try the next standard Homebrew location.
  }
}
if (!openssl) {
  throw new Error('OpenSSL is required. Install it once with `brew install openssl`.')
}

const directory = mkdtempSync(join(tmpdir(), 'jean-local-signing-'))
const config = join(directory, 'certificate.cnf')
const key = join(directory, 'key.pem')
const certificate = join(directory, 'certificate.pem')
const archive = join(directory, 'identity.p12')
const password = randomUUID()

try {
  writeFileSync(
    config,
    `[req]
prompt = no
distinguished_name = subject
x509_extensions = extensions

[subject]
CN = ${identity}

[extensions]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyCertSign
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`
  )

  run(openssl, [
    'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes',
    '-days', '3650', '-config', config, '-keyout', key, '-out', certificate,
  ], { stdio: 'ignore' })
  run(openssl, [
    'pkcs12', '-export', '-legacy', '-name', identity, '-inkey', key,
    '-in', certificate, '-out', archive, '-passout', `pass:${password}`,
  ], { stdio: 'ignore' })
  run('/usr/bin/security', [
    'import', archive, '-k', keychain, '-P', password,
    '-T', '/usr/bin/codesign', '-T', '/usr/bin/security',
  ])
  run('/usr/bin/security', [
    'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', keychain, certificate,
  ])

  const installed = run('/usr/bin/security', [
    'find-identity', '-v', '-p', 'codesigning',
  ])
  if (!installed.includes(`"${identity}"`)) {
    throw new Error('The identity was imported but macOS does not consider it valid.')
  }
  console.log(`Installed '${identity}'. Future Jean updates can now be signed locally.`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
