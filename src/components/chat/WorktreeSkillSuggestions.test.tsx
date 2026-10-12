import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@/test/test-utils'
import { WorktreeSkillSuggestions } from './WorktreeSkillSuggestions'

const state = vi.hoisted(() => ({
  name: 'planexpo',
  ci: 'pending',
  pending: [] as { path: string; name?: string }[],
  dirty: 0,
  checkedAt: 0,
  files: [] as { path: string; old_path: string | null }[],
}))
vi.mock('@/services/chat', () => ({
  useSession: () => ({
    data: {
      messages: [
        {
          role: 'user',
          content:
            '[Skill: /repo/.agents/skills/feature-flow/SKILL.md - Read and use this skill to guide your response]',
        },
        {
          role: 'assistant',
          content:
            '<!-- jean-skill-result:{"v":1,"skill":"feature-flow","outcome":"ci_passed"} -->',
        },
      ],
    },
  }),
}))
vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: [{ id: 'p', name: state.name }] }),
  useWorktrees: () => ({
    data: [
      {
        path: '/repo',
        pr_number: 10,
        cached_check_status: state.ci,
        cached_status_at: state.checkedAt,
        cached_uncommitted_added: state.dirty,
      },
    ],
  }),
}))
vi.mock('@/services/skills', () => ({
  useAllBackendSkills: () => [
    {
      backend: 'codex',
      skills: [
        {
          name: 'preview-acceptance',
          path: '/repo/.agents/skills/preview-acceptance/SKILL.md',
        },
        {
          name: 'feature-flow',
          path: '/repo/.agents/skills/feature-flow/SKILL.md',
        },
        { name: 'clickup-review', path: '/global/clickup-review/SKILL.md' },
      ],
    },
  ],
}))
vi.mock('@/services/git-status', () => ({
  getGitDiff: async () => ({ files: state.files }),
}))
vi.mock('@/store/chat-store', () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ pendingSkills: { s: state.pending } }),
}))

describe('composer skill suggestions', () => {
  beforeEach(() => {
    state.checkedAt = Date.now() / 1000 - 1
    state.name = 'planexpo'
    state.pending = []
    state.dirty = 0
    state.files = []
  })
  const props = {
    projectId: 'p',
    worktreePath: '/repo',
    sessionId: 's',
    backend: 'codex' as const,
    disabled: false,
  }
  it('selects the native skill attachment only, without a hidden prompt or submit', () => {
    const onSelect = vi.fn()
    render(<WorktreeSkillSuggestions {...props} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recetter la preview' }))
    expect(onSelect).toHaveBeenCalledWith({
      id: expect.any(String),
      name: 'preview-acceptance',
      path: '/repo/.agents/skills/preview-acceptance/SKILL.md',
    })
    expect(
      screen.queryByRole('button', { name: 'Revoir le ticket' })
    ).not.toBeInTheDocument()
  })
  it('offers publication for uncommitted code instead of testing an old preview', async () => {
    state.dirty = 14
    state.files = [{ path: 'cypress/example.cy.js', old_path: null }]
    const view = render(
      <WorktreeSkillSuggestions {...props} onSelect={vi.fn()} />
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Publier le travail' })
      ).toBeInTheDocument()
    )
    expect(
      screen.queryByRole('button', { name: 'Recetter la preview' })
    ).not.toBeInTheDocument()
    view.unmount()
  })

  it('ignores runtime jean.json edits for publication suggestions', async () => {
    state.dirty = 14
    state.files = [{ path: 'jean.json', old_path: null }]
    render(<WorktreeSkillSuggestions {...props} onSelect={vi.fn()} />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Recetter la preview' })
      ).toBeInTheDocument()
    )
    expect(
      screen.queryByRole('button', { name: 'Publier le travail' })
    ).not.toBeInTheDocument()
  })

  it('warns for an action skill selected in Plan without changing permissions', () => {
    state.pending = [
      { path: '/repo/.agents/skills/ticket-fix/SKILL.md', name: 'ticket-fix' },
    ]
    const onSelect = vi.fn()
    const view = render(
      <WorktreeSkillSuggestions
        {...props}
        executionMode="plan"
        onSelect={onSelect}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'passez de Plan à Build'
    )
    expect(onSelect).not.toHaveBeenCalled()
    view.rerender(
      <WorktreeSkillSuggestions
        {...props}
        executionMode="build"
        onSelect={onSelect}
      />
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('is not shown on another project', () => {
    state.name = 'other'
    render(<WorktreeSkillSuggestions {...props} onSelect={vi.fn()} />)
    expect(screen.queryByLabelText('Skills suggérés')).not.toBeInTheDocument()
  })
  it('hides while sending and when the skill is already attached', () => {
    const { rerender } = render(
      <WorktreeSkillSuggestions {...props} disabled onSelect={vi.fn()} />
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    state.pending = [
      { path: '/repo/.agents/skills/preview-acceptance/SKILL.md' },
    ]
    rerender(<WorktreeSkillSuggestions {...props} onSelect={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
