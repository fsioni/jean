import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { ChatInput } from './ChatInput'
import {
  appendPromptMetadataToPlainText,
  encodePromptAttachmentMetadata,
  type PromptAttachmentMetadata,
} from './message-content-utils'

const processAttachmentFile = vi.fn()

const storeState = {
  inputDrafts: {} as Record<string, string>,
  setInputDraft: vi.fn(),
  getPendingFiles: vi.fn(() => []),
  removePendingFile: vi.fn(),
  addPendingFile: vi.fn(),
  addPendingSkill: vi.fn(),
  addPendingImage: vi.fn(),
  addPendingTextFile: vi.fn(),
}

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('./attachment-processing', () => ({
  processAttachmentFile: (...args: unknown[]) => processAttachmentFile(...args),
}))

vi.mock('./FileMentionPopover', () => ({
  FileMentionPopover: () => null,
}))

vi.mock('./SlashPopover', () => ({
  SlashPopover: () => null,
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => storeState,
    subscribe: vi.fn(() => vi.fn()),
  },
}))

describe('ChatInput attachments', () => {
  const renderInput = () => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()

    render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={false}
        executionMode="build"
        focusChatShortcut="⌘K"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        formRef={formRef}
        inputRef={inputRef}
      />
    )

    return screen.getByRole('textbox') as HTMLTextAreaElement
  }

  beforeEach(() => {
    processAttachmentFile.mockReset()
    storeState.setInputDraft.mockReset()
    storeState.getPendingFiles.mockReset()
    storeState.getPendingFiles.mockReturnValue([])
    storeState.removePendingFile.mockReset()
    storeState.addPendingFile.mockReset()
    storeState.addPendingSkill.mockReset()
    storeState.addPendingImage.mockReset()
    storeState.addPendingTextFile.mockReset()
    storeState.inputDrafts = {}
  })

  it('registers attach handler and forwards selected files to the processor', async () => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()
    const attachHandlerRef: { current: (() => void) | null } = {
      current: null,
    }

    const { container } = render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={false}
        executionMode="build"
        focusChatShortcut="⌘K"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onRegisterAttachHandler={handler => {
          attachHandlerRef.current = handler
        }}
        formRef={formRef}
        inputRef={inputRef}
      />
    )

    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement
    expect(fileInput).toBeInTheDocument()

    const clickSpy = vi.spyOn(fileInput, 'click')
    expect(attachHandlerRef.current).not.toBeNull()
    if (attachHandlerRef.current) {
      attachHandlerRef.current()
    }
    expect(clickSpy).toHaveBeenCalledTimes(1)

    const file = new File(['abc'], 'upload.png', { type: 'image/png' })
    processAttachmentFile.mockResolvedValue(undefined)

    fireEvent.change(fileInput, {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(processAttachmentFile).toHaveBeenCalledWith(file, 'session-1')
    })
  })

  it('renders a shrinkable textarea that wraps long unbroken text', () => {
    const formRef = createRef<HTMLFormElement>()
    const inputRef = createRef<HTMLTextAreaElement>()

    render(
      <ChatInput
        activeSessionId="session-1"
        activeWorktreePath="/tmp/worktree"
        isSending={false}
        executionMode="yolo"
        focusChatShortcut="⌘K"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        formRef={formRef}
        inputRef={inputRef}
      />
    )

    const textarea = screen.getByRole('textbox')

    expect(textarea).toHaveAttribute('wrap', 'soft')
    expect(textarea).toHaveClass(
      'min-w-0',
      'overflow-x-hidden',
      'whitespace-pre-wrap',
      'break-words'
    )
    expect(textarea.className).toContain('[overflow-wrap:anywhere]')
    expect(textarea.parentElement).toHaveClass('min-w-0')
  })

  it('restores attachments from rich copied prompt metadata', async () => {
    const textarea = renderInput()
    const metadata: PromptAttachmentMetadata = {
      v: 1,
      images: ['/tmp/image.png'],
      textFiles: [],
      files: [
        { path: 'src/App.tsx', isDirectory: false },
        { path: 'src/components', isDirectory: true },
      ],
      skills: [{ name: 'foo', path: '/skills/foo/SKILL.md' }],
    }

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html'
            ? `<span data-jean-prompt="${encodePromptAttachmentMetadata(metadata)}">Check this</span>`
            : type === 'text/plain'
              ? 'Check this'
              : '',
        items: [],
      },
    })

    await waitFor(() => {
      expect(storeState.setInputDraft).toHaveBeenCalledWith(
        'session-1',
        'Check this'
      )
      expect(storeState.addPendingImage).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          path: '/tmp/image.png',
          filename: 'image.png',
        })
      )
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'src/App.tsx',
          isDirectory: false,
        })
      )
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'src/components',
          isDirectory: true,
        })
      )
      expect(storeState.addPendingSkill).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          name: 'foo',
          path: '/skills/foo/SKILL.md',
        })
      )
    })
  })

  it('restores attachments from plain-text copied prompt fallback', async () => {
    const textarea = renderInput()
    const metadata: PromptAttachmentMetadata = {
      v: 1,
      images: ['/tmp/image.png'],
      textFiles: [],
      files: [{ path: 'src/components', isDirectory: true }],
      skills: [],
    }
    const copiedText = appendPromptMetadataToPlainText('Check this', metadata)

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? copiedText : ''),
        items: [],
      },
    })

    await waitFor(() => {
      expect(storeState.setInputDraft).toHaveBeenCalledWith(
        'session-1',
        'Check this'
      )
      expect(storeState.addPendingImage).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({ path: '/tmp/image.png' })
      )
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'src/components',
          isDirectory: true,
        })
      )
    })

    expect(textarea.value).toBe('Check this')
  })
})
