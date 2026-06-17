#!/usr/bin/env node

import { readFileSync } from 'fs'

const input = process.argv[2]

if (!input) {
  console.error('Usage: node scripts/assert-release-version.js <vX.Y.Z|X.Y.Z>')
  process.exit(1)
}

const expected = input.startsWith('v') ? input.slice(1) : input

if (!/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(expected)) {
  console.error(`Release version must look like v1.2.3 or 1.2.3, got: ${input}`)
  process.exit(1)
}

function readJsonVersion(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof data.version !== 'string' || data.version.length === 0) {
    throw new Error(`${path} does not contain a string version field`)
  }
  return data.version
}

function readCargoVersion(path) {
  const content = readFileSync(path, 'utf8')
  const match = content.match(/^version\s*=\s*"([^"]+)"/m)
  if (!match) {
    throw new Error(`${path} does not contain a package version`)
  }
  return match[1]
}

const versions = [
  ['package.json', readJsonVersion('package.json')],
  ['src-tauri/tauri.conf.json', readJsonVersion('src-tauri/tauri.conf.json')],
  ['src-tauri/Cargo.toml', readCargoVersion('src-tauri/Cargo.toml')],
]

let hasMismatch = false

console.log(`Expected release version: ${expected}`)
for (const [path, version] of versions) {
  const ok = version === expected
  console.log(`${ok ? '✓' : '✗'} ${path}: ${version}`)
  if (!ok) {
    hasMismatch = true
  }
}

if (hasMismatch) {
  console.error(
    `Release version mismatch. Commit version updates before publishing ${input}.`
  )
  process.exit(1)
}
