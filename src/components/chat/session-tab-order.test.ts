import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import type { SessionCardData } from './session-card-utils'
import {
  buildReorderedSessionIdsWithinStatus,
  sortSessionCardsForTabs,
} from './session-tab-order'

function session(id: string, order: number, created_at = order): Session {
  return {
    id,
    name: id,
    order,
    created_at,
    updated_at: created_at,
    messages: [],
  }
}

function card(id: string, status: SessionCardData['status'], order: number) {
  return {
    session: session(id, order),
    status,
  } as SessionCardData
}

describe('session tab ordering', () => {
  it('keeps status priority while sorting sessions inside each status by manual order', () => {
    const sorted = sortSessionCardsForTabs([
      card('idle-low', 'idle', 0),
      card('waiting-high', 'waiting', 20),
      card('idle-high', 'idle', 10),
      card('waiting-low', 'waiting', 2),
    ])

    expect(sorted.map(item => item.session.id)).toEqual([
      'waiting-low',
      'waiting-high',
      'idle-low',
      'idle-high',
    ])
  })

  it('builds a persisted session order only when dragging within the same status group', () => {
    const cards = sortSessionCardsForTabs([
      card('waiting-a', 'waiting', 0),
      card('idle-a', 'idle', 1),
      card('waiting-b', 'waiting', 2),
      card('idle-b', 'idle', 3),
    ])

    expect(
      buildReorderedSessionIdsWithinStatus(cards, 'waiting-b', 'waiting-a')
    ).toEqual(['waiting-b', 'waiting-a', 'idle-a', 'idle-b'])

    expect(
      buildReorderedSessionIdsWithinStatus(cards, 'waiting-a', 'idle-a')
    ).toBeNull()
  })
})
