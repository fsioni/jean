import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { EditedFilesDisplay } from './EditedFilesDisplay'
import type { ToolCall } from '@/types/chat'

const diffModalMock = vi.hoisted(() => vi.fn())

vi.mock('./MessageDiffModal', () => ({
  MessageDiffModal: (props: { patch?: string | null }) => {
    diffModalMock(props)
    return <div data-testid="message-diff-modal">{props.patch}</div>
  },
}))

describe('EditedFilesDisplay', () => {
  beforeEach(() => {
    diffModalMock.mockClear()
  })

  it('renders Codex FileChange tool calls with file stats', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'fc-1',
        name: 'FileChange',
        input: [
          {
            path: 'src-tauri/src/chat/codex.rs',
            kind: { type: 'update' },
            diff: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+another line\n context\n',
          },
          {
            path: 'src/components/chat/EditedFilesDisplay.tsx',
            kind: { type: 'update' },
            diff: '@@ -10,2 +10,2 @@\n-old\n+new\n',
          },
        ],
      },
    ]

    render(<EditedFilesDisplay toolCalls={toolCalls} />)

    expect(screen.getByText('Edited 2 files:')).toBeVisible()
    expect(screen.getByText('codex.rs')).toBeVisible()
    expect(screen.getByText('EditedFilesDisplay.tsx')).toBeVisible()
    expect(screen.getByText('+2')).toBeVisible()
    expect(screen.getAllByText('-1')).toHaveLength(2)
  })

  it('opens a Codex FileChange diff as a unified patch', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'fc-1',
        name: 'FileChange',
        input: [
          {
            path: 'src-tauri/src/chat/codex.rs',
            diff: '@@ -1,2 +1,3 @@\n-old line\n+new line\n+another line\n context\n',
          },
        ],
      },
    ]

    render(<EditedFilesDisplay toolCalls={toolCalls} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'View changes to codex.rs' })
    )

    expect(screen.getByTestId('message-diff-modal')).toBeVisible()
    expect(diffModalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: 'src-tauri/src/chat/codex.rs',
        edits: [],
        patch: expect.stringContaining(
          '--- src-tauri/src/chat/codex.rs\n+++ src-tauri/src/chat/codex.rs'
        ),
      })
    )
    expect(diffModalMock.mock.lastCall?.[0].patch).toContain(
      '+another line'
    )
  })
})
