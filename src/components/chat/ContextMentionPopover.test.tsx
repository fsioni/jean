import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { Bug, GitPullRequest } from 'lucide-react'
import { ContextMentionPopover } from './ContextMentionPopover'
import type { ContextMentionItem } from './hooks/useContextMentionData'

const items: ContextMentionItem[] = [
  {
    id: 'issue:123',
    type: 'issue',
    label: '#123',
    title: 'Fix login bug',
    subtitle: 'open issue by alice',
    badge: 'open',
    icon: Bug,
  },
  {
    id: 'pr:45',
    type: 'pr',
    label: 'PR #45',
    title: 'Add context mentions',
    subtitle: 'open main ← feature',
    badge: 'open',
    icon: GitPullRequest,
  },
]

vi.mock('./hooks/useContextMentionData', () => ({
  useContextMentionData: () => ({
    groups: [
      { id: 'issue', heading: 'GitHub Issues', items: [items[0]] },
      { id: 'pr', heading: 'GitHub Pull Requests', items: [items[1]] },
    ],
    isFetching: false,
  }),
}))

describe('ContextMentionPopover', () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders grouped context mention results', () => {
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={vi.fn()}
        searchQuery="123"
        anchorPosition={{ top: 0, left: 0 }}
        containerWidth={480}
      />
    )

    expect(screen.getByText('GitHub Issues')).toBeInTheDocument()
    expect(screen.getByText('GitHub Pull Requests')).toBeInTheDocument()
    expect(screen.getByText('#123')).toBeInTheDocument()
    expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    expect(screen.getByText('PR #45')).toBeInTheDocument()
  })
})
