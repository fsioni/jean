import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { render } from '@/test/test-utils'
import type * as Environment from '@/lib/environment'
import App from './App'

vi.mock('@/lib/remote-connections', () => ({
  getActiveRemoteConnection: () => ({
    id: 'remote-1',
    name: 'Build server',
    url: 'https://jean.example.com',
    token: 'secret',
  }),
}))

vi.mock('@/lib/build-info', () => ({
  CLIENT_BUILD_INFO: { appVersion: 'test' },
  CLIENT_WEB_BUILD_ID: 'test',
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof Environment>()),
  isNativeApp: () => true,
}))

vi.mock('./components/remote/RemoteWebAccessShell', () => ({
  RemoteWebAccessShell: ({ connection }: { connection: { name: string } }) => (
    <div>Remote UI: {connection.name}</div>
  ),
}))

describe('App remote UI', () => {
  it('uses the server-hosted React UI for an active native remote', () => {
    render(<App />)

    expect(screen.getByText('Remote UI: Build server')).toBeInTheDocument()
  })
})
