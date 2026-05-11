import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { MessageSettingsBadges } from './MessageSettingsBadges'

describe('MessageSettingsBadges', () => {
  it('renders Codex fast model labels instead of raw ids', () => {
    render(
      <MessageSettingsBadges
        model="gpt-5.5-fast"
        executionMode="yolo"
        thinkingLevel={undefined}
        effortLevel="medium"
        isCursor={false}
      />
    )

    expect(screen.getByText('GPT 5.5 Fast')).toBeVisible()
    expect(screen.getByText('· yolo')).toBeVisible()
    expect(screen.getByText('· Medium')).toBeVisible()
  })

  it('renders Codex base model labels', () => {
    render(
      <MessageSettingsBadges
        model="gpt-5.4"
        executionMode="plan"
        thinkingLevel={undefined}
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('GPT 5.4')).toBeVisible()
  })

  it('does not show Claude thinking labels for Codex models', () => {
    render(
      <MessageSettingsBadges
        model="gpt-5.5-fast"
        executionMode="plan"
        thinkingLevel="megathink"
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('GPT 5.5 Fast')).toBeVisible()
    expect(screen.queryByText('· Megathink')).toBeNull()
  })

  it('keeps Claude model labels working', () => {
    render(
      <MessageSettingsBadges
        model="haiku"
        executionMode="plan"
        thinkingLevel="think"
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('Haiku')).toBeVisible()
    expect(screen.getByText('· Think')).toBeVisible()
  })

  it('renders Claude fast model labels instead of raw ids', () => {
    render(
      <MessageSettingsBadges
        model="claude-opus-4-6[1m]-fast"
        executionMode="plan"
        thinkingLevel={undefined}
        effortLevel="high"
        isCursor={false}
      />
    )

    expect(screen.getByText('Opus 4.6 (1M) Fast')).toBeVisible()
    expect(screen.getByText('· plan')).toBeVisible()
    expect(screen.getByText('· High')).toBeVisible()
    expect(screen.queryByText('claude-opus-4-6[1m]-fast')).toBeNull()
  })

  it('formats unknown slash models as provider labels', () => {
    render(
      <MessageSettingsBadges
        model="openrouter/anthropic/claude-3.5-haiku"
        executionMode={undefined}
        thinkingLevel={undefined}
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('Claude 3.5 Haiku (Anthropic)')).toBeVisible()
  })

  it('falls back to raw ids for unknown non-slash models', () => {
    render(
      <MessageSettingsBadges
        model="unknown-model"
        executionMode={undefined}
        thinkingLevel={undefined}
        effortLevel={undefined}
        isCursor={false}
      />
    )

    expect(screen.getByText('unknown-model')).toBeVisible()
  })
})
