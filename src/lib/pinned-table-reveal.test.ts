import { describe, expect, it } from 'vitest'
import {
  findTableMessageIndex,
  findTableMessageIndexByMarkdown,
  isSameTableKey,
  renameTableKeyMessage,
  tableKeyForMessage,
} from './pinned-table-reveal'

const MESSAGES = [{ id: 'u1' }, { id: 'a1' }, { id: 'u2' }, { id: 'a2' }]

describe('findTableMessageIndex', () => {
  it('finds the message of a plain table key', () => {
    expect(findTableMessageIndex(MESSAGES, 'a1:120')).toBe(1)
  })

  it('finds the last message of a compact group key', () => {
    expect(findTableMessageIndex(MESSAGES, 'compact-a1:0')).toBe(1)
    expect(findTableMessageIndex(MESSAGES, 'compact-u2-a2:40')).toBe(3)
  })

  it('returns -1 when the message is not loaded', () => {
    expect(findTableMessageIndex(MESSAGES, 'old:0')).toBe(-1)
    expect(findTableMessageIndex(MESSAGES, 'compact-old:0')).toBe(-1)
  })
})

describe('isSameTableKey', () => {
  it('matches the same table in full and compact views', () => {
    expect(isSameTableKey('a2:40', 'compact-u2-a2:40', 'a2')).toBe(true)
    expect(isSameTableKey('compact-a2:40', 'a2:40', 'a2')).toBe(true)
    expect(isSameTableKey('compact-u2-a2:40', 'a2:40', 'a2')).toBe(true)
  })

  it('does not match another table or message', () => {
    expect(isSameTableKey('a2:41', 'a2:40', 'a2')).toBe(false)
    expect(isSameTableKey('a1:40', 'a2:40', 'a2')).toBe(false)
    expect(isSameTableKey('a2:40', 'compact-a2:40', null)).toBe(false)
  })
})

describe('findTableMessageIndexByMarkdown', () => {
  const table = '| a | b |\n|---|---|\n| 1 | 2 |'
  const messages = [
    { content: 'intro' },
    { content: `see\n\n${table}\n` },
    { content: '', content_blocks: [{ type: 'text', text: `${table}` }] },
    { content: 'later' },
  ]

  it('finds the latest message that holds the table', () => {
    expect(findTableMessageIndexByMarkdown(messages, `${table}\n`)).toBe(2)
    expect(findTableMessageIndexByMarkdown(messages.slice(0, 2), table)).toBe(1)
  })

  it('returns -1 for empty or missing markdown', () => {
    expect(findTableMessageIndexByMarkdown(messages, '  ')).toBe(-1)
    expect(findTableMessageIndexByMarkdown(messages, '| x |')).toBe(-1)
  })
})

describe('renameTableKeyMessage', () => {
  it('renames plain and compact keys of the message', () => {
    expect(renameTableKeyMessage('old:40', 'old', 'new')).toBe('new:40')
    expect(renameTableKeyMessage('compact-old:40', 'old', 'new')).toBe(
      'compact-new:40'
    )
    expect(renameTableKeyMessage('compact-u1-old:40', 'old', 'new')).toBe(
      'compact-u1-new:40'
    )
  })

  it('keeps keys of other messages', () => {
    expect(renameTableKeyMessage('a1:40', 'old', 'new')).toBe('a1:40')
    expect(renameTableKeyMessage('compact-old-a2:40', 'old', 'new')).toBe(
      'compact-old-a2:40'
    )
  })
})

describe('tableKeyForMessage', () => {
  it('keeps the offset and uses the new message id', () => {
    expect(tableKeyForMessage('stale:7828', 'a2')).toBe('a2:7828')
    expect(tableKeyForMessage('compact-u1-stale:12', 'a2')).toBe('a2:12')
  })
})
