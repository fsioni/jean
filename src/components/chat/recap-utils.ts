import type { ChatMessage, ContentBlock } from '@/types/chat'

export const RECAP_HEADING_RE = /^##\s+Recap\s*$/im

export function extractRecapSection(text: string): string | null {
  const match = RECAP_HEADING_RE.exec(text)
  if (!match) return null
  const start = match.index
  const afterHeading = start + match[0].length
  const rest = text.slice(afterHeading)
  const nextHeading = /^#{1,2}\s+/m.exec(rest)
  const end = nextHeading ? afterHeading + nextHeading.index : text.length
  return text.slice(start, end).trim() || null
}

export function stripRecapFromText(text: string): string {
  const match = RECAP_HEADING_RE.exec(text)
  if (!match) return text
  const start = match.index
  const afterHeading = start + match[0].length
  const rest = text.slice(afterHeading)
  const nextHeading = /^#{1,2}\s+/m.exec(rest)
  const before = text.slice(0, start).trimEnd()
  const after = nextHeading ? text.slice(afterHeading + nextHeading.index) : ''
  return after ? `${before}\n\n${after}`.trim() : before
}

export function stripRecapFromMessage(message: ChatMessage): ChatMessage {
  const blocks = message.content_blocks
  let changed = false
  let newBlocks: ContentBlock[] | undefined
  if (blocks && blocks.length > 0) {
    newBlocks = []
    for (const block of blocks) {
      if (block?.type === 'text' && RECAP_HEADING_RE.test(block.text)) {
        const stripped = stripRecapFromText(block.text)
        changed = true
        if (stripped) newBlocks.push({ ...block, text: stripped })
      } else {
        newBlocks.push(block)
      }
    }
  }
  let newContent = message.content
  if (newContent && RECAP_HEADING_RE.test(newContent)) {
    const stripped = stripRecapFromText(newContent)
    if (stripped !== newContent) {
      newContent = stripped
      changed = true
    }
  }
  if (!changed) return message
  return {
    ...message,
    ...(newBlocks ? { content_blocks: newBlocks } : {}),
    ...(newContent !== message.content ? { content: newContent } : {}),
  }
}

export function findLatestRecapSection(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue

    const texts: string[] = []
    for (const block of message.content_blocks ?? []) {
      if (block?.type === 'text' && block.text.trim()) {
        texts.push(block.text)
      }
    }
    if (texts.length === 0 && message.content?.trim()) {
      texts.push(message.content)
    }

    const recap = extractRecapSection(texts.join('\n\n'))
    if (recap) return recap
  }
  return null
}
