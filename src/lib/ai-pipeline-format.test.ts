import { describe, expect, it } from 'vitest'
import { formatAge, taskMatchesQuery } from './ai-pipeline-format'
import type { AiPipelineTask } from '@/types/ai-pipeline'

const NOW = Date.parse('2026-07-21T12:00:00Z')

function task(overrides: Partial<AiPipelineTask> = {}): AiPipelineTask {
  return {
    taskId: '86caue6m8',
    name: '💡 ETO je vois le statut Facture X de chaque facture',
    status: 'stuck',
    assignedToMe: false,
    tags: ['ai-done'],
    ...overrides,
  }
}

describe('formatAge', () => {
  it('reads ClickUp epoch-ms strings', () => {
    const threeDaysAgo = String(NOW - 3 * 24 * 60 * 60 * 1000)
    expect(formatAge(threeDaysAgo, NOW)).toBe('3 j')
  })

  it('reads ISO-8601 dates (PR createdAt)', () => {
    expect(formatAge('2026-07-21T07:00:00Z', NOW)).toBe('5 h')
    expect(formatAge('2026-07-21T11:48:00Z', NOW)).toBe('12 min')
  })

  it('returns null when there is nothing usable', () => {
    expect(formatAge(undefined, NOW)).toBeNull()
    expect(formatAge('', NOW)).toBeNull()
    expect(formatAge('not-a-date', NOW)).toBeNull()
  })
})

describe('taskMatchesQuery', () => {
  it('matches on title, ignoring case and accents', () => {
    expect(
      taskMatchesQuery(task({ name: 'Règlement des factures' }), 'reglement')
    ).toBe(true)
    expect(
      taskMatchesQuery(task({ name: 'Règlement des factures' }), 'RÉGLEMENT')
    ).toBe(true)
  })

  it('matches on ClickUp id, tag and PR number', () => {
    const withPr = task({
      pr: {
        number: 4140,
        title: 'feat: something',
        branch: 'CU-86caue6m8-statut-facture',
        url: 'https://github.com/o/r/pull/4140',
        isDraft: false,
        createdAt: '2026-07-20T10:00:00Z',
        labels: [],
        repoSlug: 'o/r',
      },
    })
    expect(taskMatchesQuery(withPr, '86caue6m8')).toBe(true)
    expect(taskMatchesQuery(withPr, 'ai-done')).toBe(true)
    expect(taskMatchesQuery(withPr, '4140')).toBe(true)
    expect(taskMatchesQuery(withPr, 'statut-facture')).toBe(true)
    expect(taskMatchesQuery(withPr, 'inexistant')).toBe(false)
  })

  it('keeps everything when the query is blank', () => {
    expect(taskMatchesQuery(task(), '')).toBe(true)
    expect(taskMatchesQuery(task(), '   ')).toBe(true)
  })
})
