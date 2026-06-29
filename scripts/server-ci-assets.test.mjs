import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = path => readFileSync(path, 'utf8')

test('server release workflow builds binaries and publishes docker image', () => {
  const workflow = read('.github/workflows/server-release.yml')

  assert.match(workflow, /cargo build --release --bin jean-server/)
  assert.match(workflow, /jean-server-linux-amd64/)
  assert.match(workflow, /jean-server-linux-arm64/)
  assert.match(workflow, /docker\/build-push-action@v6/)
  assert.match(workflow, /ghcr\.io/)
})

test('Dockerfile builds and runs jean-server headlessly as non-root user', () => {
  const dockerfile = read('Dockerfile.server')

  assert.match(dockerfile, /bun run build/)
  assert.match(dockerfile, /cargo build --release --bin jean-server/)
  assert.match(dockerfile, /USER jean/)
  assert.match(dockerfile, /chown -R jean:jean \/home\/jean/)
  assert.match(dockerfile, /JEAN_HOST=0\.0\.0\.0/)
  assert.match(dockerfile, /xvfb/)
  assert.match(dockerfile, /jean-server-entrypoint/)
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/jean-server-entrypoint"\]/)
})


test('Docker entrypoint starts Xvfb before jean-server', () => {
  const entrypoint = read('scripts/docker-entrypoint.sh')

  assert.match(entrypoint, /Xvfb :99/)
  assert.match(entrypoint, /export DISPLAY=:99/)
  assert.match(entrypoint, /sleep 0\.5/)
  assert.match(entrypoint, /exec jean-server "\$@"/)
})
