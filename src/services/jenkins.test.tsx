import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { jenkinsQueryKeys, useJenkinsStatusCached } from './jenkins'
import type { JenkinsWorktreeStatus } from '@/types/jenkins'

describe('jenkinsQueryKeys', () => {
  it('namespaces status under "jenkins"', () => {
    expect(jenkinsQueryKeys.all).toEqual(['jenkins'])
    expect(jenkinsQueryKeys.status('wt-1')).toEqual(['jenkins', 'status', 'wt-1'])
  })
})

function makeWrapper(client: QueryClient) {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  Wrapper.displayName = 'TestQueryWrapper'
  return Wrapper
}

const seededStatus: JenkinsWorktreeStatus = {
  worktreeId: 'wt-1',
  prId: '42',
  pipeline: {
    number: 7,
    result: 'SUCCESS',
    building: false,
    timestampMs: 0,
    durationMs: 1000,
    url: 'https://ci/job/7',
    prId: '42',
    branch: 'feature',
  },
  stages: [],
  integrationAttempts: [],
  preview: null,
  previewUrl: null,
  previewFreshness: null,
  queue: null,
  overallStatus: 'SUCCESS',
  checkedAt: 0,
}

describe('useJenkinsStatusCached', () => {
  it('returns the poller-seeded cache value without fetching', () => {
    const client = new QueryClient()
    client.setQueryData(jenkinsQueryKeys.status('wt-1'), seededStatus)

    const { result } = renderHook(() => useJenkinsStatusCached('wt-1'), {
      wrapper: makeWrapper(client),
    })

    expect(result.current.data).toEqual(seededStatus)
    // enabled:false ⇒ the throwing queryFn never runs.
    expect(result.current.isFetching).toBe(false)
    expect(result.current.isError).toBe(false)
  })

  it('stays undefined and idle when the cache is empty (never fetches)', () => {
    const client = new QueryClient()

    const { result } = renderHook(() => useJenkinsStatusCached('wt-empty'), {
      wrapper: makeWrapper(client),
    })

    expect(result.current.data).toBeUndefined()
    expect(result.current.isFetching).toBe(false)
    expect(result.current.isError).toBe(false)
  })
})
