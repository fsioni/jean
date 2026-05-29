import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { ReviewCommentsDialog } from './ReviewCommentsDialog'

const mocks = vi.hoisted(() => {
  let reviewCommentsModalOpen = true

  return {
    getReviewCommentsModalOpen: () => reviewCommentsModalOpen,
    setReviewCommentsModalOpen: vi.fn((open: boolean) => {
      reviewCommentsModalOpen = open
    }),
    resetReviewCommentsModalOpen: (open = true) => {
      reviewCommentsModalOpen = open
    },
    setPendingMagicCommand: vi.fn(),
    invokeMock: vi.fn(),
  }
})

vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    reviewCommentsModalOpen: mocks.getReviewCommentsModalOpen(),
    setReviewCommentsModalOpen: mocks.setReviewCommentsModalOpen,
  }),
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({
      selectedProjectId: 'project-1',
      selectedWorktreeId: 'wt-1',
    }),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => ({
      activeWorktreePath: '/repo/worktree',
      setPendingMagicCommand: mocks.setPendingMagicCommand,
    }),
  },
}))

vi.mock('@/services/projects', () => ({
  useWorktrees: () => ({
    data: [
      {
        id: 'wt-1',
        path: '/repo/worktree',
        pr_number: 123,
      },
    ],
  }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invokeMock }))

describe('ReviewCommentsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetReviewCommentsModalOpen()
    mocks.invokeMock.mockImplementation(
      (command: string, _args: Record<string, unknown>) => {
        if (command === 'get_pr_review_comments') {
          return Promise.resolve([
            {
              path: 'src/file.ts',
              line: 12,
              body: 'Please fix this',
              diffHunk: '@@ -1 +1 @@',
              createdAt: '2026-05-25T10:00:00Z',
              author: { login: 'reviewer' },
            },
          ])
        }

        if (command === 'get_github_pr') {
          return Promise.resolve({
            comments: [],
            reviews: [],
          })
        }

        return Promise.reject(new Error(`unexpected command: ${command}`))
      }
    )
  })

  it('clears send loading state when reopened after sending comments to chat', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ReviewCommentsDialog />)

    const sendButton = await screen.findByRole('button', {
      name: /send to chat \(1\)/i,
    })
    expect(sendButton).toBeEnabled()

    await user.click(sendButton)

    await waitFor(() => {
      expect(mocks.setReviewCommentsModalOpen).toHaveBeenCalledWith(false)
    })

    mocks.resetReviewCommentsModalOpen()
    rerender(<ReviewCommentsDialog />)

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /send to chat \(1\)/i })
      ).toBeEnabled()
    })
  })
})
