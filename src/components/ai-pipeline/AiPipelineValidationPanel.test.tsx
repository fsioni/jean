import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { ValidationExecution } from '@/types/ai-pipeline'
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}))
const control = vi.fn()
const start = vi.fn()
const query = vi.fn()
vi.mock('@/services/ai-pipeline', () => ({
  useControlAiPipelineValidation: () => ({ mutate: control, isPending: false }),
  useStartAiPipelineValidation: () => ({ mutate: start, isPending: false }),
  useAiPipelineValidations: () => query(),
}))
import {
  AiPipelineValidationPanel,
  ValidationCard,
  hasCurrentProof,
} from './AiPipelineValidationPanel'
const fixture = (
  overrides: Partial<ValidationExecution> = {}
): ValidationExecution => ({
  schema_version: 1,
  id: 'v1',
  project_id: 'p1',
  worktree_id: 'w1',
  repository_path: '/tmp/w1',
  task_id: 't1',
  pr_number: 42,
  revision: 1,
  step: 'review',
  status: 'blocked',
  created_at: '',
  updated_at: '',
  head_commit: 'abc',
  deployed_commit: 'def',
  correction_cycles: 1,
  no_progress_cycles: 0,
  requirements: [],
  evidence: [],
  defects: [],
  transitions: [],
  blocker: 'Accès indisponible',
  paused: false,
  limitations: [],
  effects: [],
  ...overrides,
})
describe('private validation evidence', () => {
  it('shows the live activity rather than a fixed stage checklist', () => {
    const view = render(
      <ValidationCard
        execution={fixture({ pr_number: null, step: 'implementation' })}
      />
    )
    expect(view.getByText('Implémentation')).toBeInTheDocument()
    expect(
      view.queryByLabelText('Étapes de validation')
    ).not.toBeInTheDocument()
    expect(view.queryByText('Création PR')).not.toBeInTheDocument()
  })
  it('keeps transition history collapsed until requested', () => {
    const view = render(
      <ValidationCard
        execution={fixture({
          transitions: [
            {
              revision: 1,
              step: 'acceptance',
              status: 'running',
              message: 'Retour en correction du filtre',
              timestamp: '2026-10-07T10:00:00Z',
            },
            {
              revision: 2,
              step: 'correction',
              status: 'running',
              message: 'Correction en cours',
              timestamp: '2026-10-07T10:01:00Z',
            },
          ],
        })}
      />
    )
    expect(
      view.getByText('Journal d’activité (2)').closest('details')
    ).not.toHaveAttribute('open')
    fireEvent.click(view.getByText('Journal d’activité (2)'))
    expect(
      view.getByText('Journal d’activité (2)').closest('details')
    ).toHaveAttribute('open')
    expect(view.getByText('Retour en correction du filtre')).toBeInTheDocument()
  })
  it('never announces ready without mandatory evidence', () => {
    const view = render(
      <ValidationCard execution={fixture({ status: 'ready' })} />
    )
    expect(view.getByText('Preuves à confirmer')).toBeInTheDocument()
    expect(view.queryByText('Prêt pour ta décision')).not.toBeInTheDocument()
  })
  it('accepts differing tested and deployed SHA but rejects stale evidence', () => {
    const execution = fixture({
      status: 'ready',
      requirements: [
        {
          id: 'r',
          label: 'Recette',
          mandatory: true,
          status: 'passed',
          evidence_ids: ['e'],
        },
      ],
      acceptance_evidence_ids: ['e'],
      evidence: [
        {
          id: 'ci-head',
          label: 'CI',
          kind: 'backend-ci',
          value: 'Verified',
          commit: 'abc',
          stale: false,
        },
        {
          id: 'preview-version',
          label: 'Version',
          kind: 'git-ancestry',
          value: 'Verified',
          commit: 'abc',
          stale: false,
        },
        {
          id: 'e',
          label: 'Sauvegarde',
          kind: 'test',
          value: 'OK',
          commit: 'abc',
          stale: false,
        },
      ],
    })
    expect(hasCurrentProof(execution)).toBe(true)
    execution.evidence = execution.evidence.map(e => ({ ...e, stale: true }))
    expect(hasCurrentProof(execution)).toBe(false)
    const view = render(<ValidationCard execution={execution} />)
    fireEvent.click(
      view.getByRole('button', { name: 'Voir les preuves et limites' })
    )
    expect(view.getByText('abc')).toBeInTheDocument()
    expect(view.getByText('def')).toBeInTheDocument()
    expect(view.getAllByText('· périmée')).toHaveLength(
      execution.evidence.length
    )
  })
  it('requires recipe proof for every passed mandatory criterion, not only one', () => {
    const execution = fixture({
      status: 'ready',
      requirements: [
        {
          id: 'save',
          label: 'Sauvegarde',
          mandatory: true,
          status: 'passed',
          evidence_ids: ['save-proof'],
        },
        {
          id: 'reload',
          label: 'Rechargement',
          mandatory: true,
          status: 'passed',
          evidence_ids: ['reload-proof'],
        },
        {
          id: 'ci-head',
          label: 'CI du commit',
          mandatory: true,
          status: 'passed',
          evidence_ids: ['ci-head'],
        },
      ],
      acceptance_evidence_ids: ['save-proof'],
      evidence: [
        {
          id: 'ci-head',
          label: 'CI',
          kind: 'backend-ci',
          value: 'Verified',
          commit: 'abc',
          stale: false,
        },
        {
          id: 'preview-version',
          label: 'Version',
          kind: 'git-ancestry',
          value: 'Verified',
          commit: 'abc',
          stale: false,
        },
        {
          id: 'save-proof',
          label: 'Sauvegarde',
          kind: 'test',
          value: 'OK',
          commit: 'abc',
          stale: false,
        },
        {
          id: 'reload-proof',
          label: 'Review rechargement',
          kind: 'test',
          value: 'OK',
          commit: 'abc',
          stale: false,
        },
      ],
    })
    expect(hasCurrentProof(execution)).toBe(false)
    const view = render(<ValidationCard execution={execution} />)
    expect(view.getByText('Preuves à confirmer')).toBeInTheDocument()
    execution.acceptance_evidence_ids = ['save-proof', 'reload-proof']
    expect(hasCurrentProof(execution)).toBe(true)
    view.rerender(<ValidationCard execution={execution} />)
    expect(view.getByText('Prêt pour ta décision')).toBeInTheDocument()
  })
  it('requires every evidence reference and every external effect confirmation', () => {
    const execution = fixture({
      requirements: [
        {
          id: 'r',
          label: 'Recette',
          mandatory: true,
          status: 'passed',
          evidence_ids: ['e', 'missing'],
        },
      ],
      acceptance_evidence_ids: ['e'],
      evidence: [
        {
          id: 'ci-head',
          label: 'CI',
          kind: 'backend-ci',
          value: 'Verified',
          commit: 'abc',
          stale: false,
        },
        {
          id: 'preview-version',
          label: 'Version',
          kind: 'git-ancestry',
          value: 'Verified',
          commit: 'abc',
          stale: false,
        },
        {
          id: 'e',
          label: 'Test',
          kind: 'test',
          value: 'OK',
          commit: 'abc',
          stale: false,
        },
      ],
    })
    expect(hasCurrentProof(execution)).toBe(false)
    execution.requirements = execution.requirements.map(r => ({
      ...r,
      evidence_ids: ['e'],
    }))
    execution.effects = [
      { id: 'push', kind: 'push', intended_commit: 'abc', confirmed: false },
    ]
    expect(hasCurrentProof(execution)).toBe(false)
  })
  it('prepares an editable local draft without publishing', () => {
    const view = render(<ValidationCard execution={fixture()} />)
    fireEvent.click(view.getByRole('button', { name: 'Préparer mon retour' }))
    const draft = view.getByRole('textbox', { name: /Brouillon privé/ })
    fireEvent.change(draft, {
      target: { value: 'Je vérifie encore ce point.' },
    })
    expect(draft).toHaveValue('Je vérifie encore ce point.')
    expect(
      view.queryByRole('button', { name: /Publier/ })
    ).not.toBeInTheDocument()
  })
  it('requires explicit confirmation to create a new execution', () => {
    start.mockClear()
    const view = render(<ValidationCard execution={fixture()} />)
    fireEvent.click(view.getByRole('button', { name: 'Nouvelle validation…' }))
    expect(start).not.toHaveBeenCalled()
    fireEvent.click(
      view.getByRole('button', { name: 'Confirmer la nouvelle validation' })
    )
    expect(start).toHaveBeenCalledWith(
      { worktreeId: 'w1', taskId: 't1', prNumber: 42, newExecution: true },
      expect.anything()
    )
  })
  it('never puts internal automation limitations into the colleague draft', () => {
    const view = render(
      <ValidationCard
        execution={fixture({
          blocker: 'Le run agent est interrompu',
          limitations: ['Les outils des agents ne sont pas confinés'],
        })}
      />
    )
    fireEvent.click(view.getByRole('button', { name: 'Préparer mon retour' }))
    const draft = view.getByRole('textbox', {
      name: /Brouillon privé/,
    }) as HTMLTextAreaElement
    expect(draft.value).not.toMatch(/agent|confinés|run/i)
  })
  it('rejects generic ready proofs when backend CI or acceptance is missing', () => {
    const execution = fixture({
      status: 'ready',
      requirements: [
        {
          id: 'r',
          label: 'AC',
          mandatory: true,
          status: 'passed',
          evidence_ids: ['e'],
        },
      ],
      evidence: [
        {
          id: 'e',
          label: 'A check',
          kind: 'test',
          value: 'OK',
          commit: 'abc',
          stale: false,
        },
      ],
    })
    expect(hasCurrentProof(execution)).toBe(false)
  })
  it('restores a validation even when its ticket disappeared from the pickable list', () => {
    query.mockReturnValue({
      data: [fixture()],
      isLoading: false,
      isError: false,
    })
    const view = render(
      <AiPipelineValidationPanel projectId="p1" enabled worktreeId="w1" />
    )
    expect(
      view.getByRole('region', { name: 'Automatisation du worktree' })
    ).toBeInTheDocument()
    expect(
      view.queryByRole('button', { name: 'Validation existante' })
    ).not.toBeInTheDocument()
    fireEvent.click(
      view.getByRole('button', { name: 'Reprendre la validation' })
    )
    expect(control).toHaveBeenCalledWith(
      { executionId: 'v1', action: 'resume' },
      expect.anything()
    )
  })
})

describe('worktree validation focus', () => {
  it('shows one execution and hides past executions and other worktrees', () => {
    query.mockReturnValue({
      data: [
        fixture({
          id: 'old',
          task_id: 'old',
          status: 'ready',
          updated_at: '2026-01-01',
        }),
        fixture({
          id: 'active',
          task_id: 'active',
          status: 'running',
          updated_at: '2026-01-02',
        }),
        fixture({ id: 'other', worktree_id: 'w2', task_id: 'other' }),
      ],
      isLoading: false,
      isError: false,
    })
    const view = render(
      <AiPipelineValidationPanel projectId="p1" enabled worktreeId="w1" />
    )
    expect(view.getAllByText(/Review|Revue/).length).toBeGreaterThan(0)
    expect(
      view.getByText('Exécutions précédentes (1)').closest('details')
    ).not.toHaveAttribute('open')
    expect(view.queryByText('Ticket other · PR #42')).not.toBeInTheDocument()
    expect(view.getByText('Automatisation')).toBeInTheDocument()
    fireEvent.click(view.getByText('Exécutions précédentes (1)'))
    expect(view.getByText('Ticket old · PR #42')).toBeInTheDocument()
  })
})

it('opens technical sessions only when explicitly requested, including historical executions', () => {
  const open = vi.fn()
  const view = render(
    <ValidationCard
      execution={fixture({
        agent_sessions: [
          { session_id: 'technical', step: 'correction', attempt_id: 'a1' },
        ],
        superseded_by: 'new',
      })}
      onOpenSession={open}
    />
  )
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(view.getByText('Sessions techniques'))
  fireEvent.click(view.getByRole('button', { name: 'Correction · 1' }))
  expect(open).toHaveBeenCalledWith('technical')
})

it('keeps a discreet manual launch on linked worktrees without an execution', () => {
  query.mockReturnValue({ data: [], isLoading: false, isError: false })
  const view = render(
    <AiPipelineValidationPanel
      projectId="p1"
      enabled
      worktreeId="w1"
      allowStart
    />
  )
  fireEvent.click(view.getByRole('button', { name: 'Lancer la validation' }))
  expect(start).toHaveBeenCalledWith(
    { worktreeId: 'w1', taskId: undefined },
    expect.anything()
  )
})

it('does not expose the pipeline on an unrelated worktree', () => {
  query.mockReturnValue({ data: [], isLoading: false, isError: false })
  const view = render(
    <AiPipelineValidationPanel projectId="p1" enabled worktreeId="w1" />
  )
  expect(
    view.queryByLabelText('Automatisation du worktree')
  ).not.toBeInTheDocument()
})

it('keeps unproven readiness qualified in the compact worktree summary', () => {
  query.mockReturnValue({
    data: [fixture({ status: 'ready' })],
    isLoading: false,
    isError: false,
  })
  const view = render(
    <AiPipelineValidationPanel projectId="p1" enabled worktreeId="w1" />
  )
  expect(view.getByText(/Preuves à confirmer/)).toBeInTheDocument()
  expect(view.queryByText(/Prêt pour ta décision/)).not.toBeInTheDocument()
})

describe('honest correction recovery actions', () => {
  it.each([
    'Correction limit reached; manual decision required',
    'Limite de correction atteinte : 3 tentatives maximum ou 2 tentatives sans progrès vérifié. Une décision explicite est nécessaire pour poursuivre.',
  ])(
    'does not offer a resume that cannot pass an exhausted correction budget: %s',
    blocker => {
      const view = render(
        <ValidationCard
          execution={fixture({
            step: 'ci',
            correction_cycles: 3,
            blocker,
            transitions: [
              {
                revision: 2,
                step: 'ci',
                status: 'blocked',
                message: blocker,
                timestamp: '',
              },
            ],
          })}
        />
      )
      expect(
        view.queryByRole('button', { name: 'Reprendre la validation' })
      ).not.toBeInTheDocument()
      expect(view.getByRole('alert')).toHaveTextContent(
        /Limite de corrections? atteinte/
      )
      expect(
        view.getByRole('button', { name: 'Nouvelle validation…' })
      ).toBeInTheDocument()
      if (blocker.startsWith('Correction limit')) {
        expect(view.queryByText(blocker)).not.toBeInTheDocument()
      }
    }
  )

  it('does not repeat the same blocker as the current activity', () => {
    const view = render(
      <ValidationCard
        execution={fixture({
          transitions: [
            {
              revision: 2,
              step: 'review',
              status: 'blocked',
              message: 'Accès indisponible',
              timestamp: '',
            },
          ],
        })}
      />
    )
    // One alert and one preserved historical entry, not a third current summary.
    expect(view.getAllByText('Accès indisponible')).toHaveLength(2)
  })

  it('retains resume for a technical correction failure with budget remaining', () => {
    const view = render(
      <ValidationCard
        execution={fixture({
          step: 'correction',
          status: 'failed',
          correction_cycles: 0,
          blocker: 'Le run agent est interrompu',
        })}
      />
    )
    expect(
      view.getByRole('button', { name: 'Reprendre la validation' })
    ).toBeInTheDocument()
  })

  it('does not infer exhaustion from three cycles on a paused review', () => {
    control.mockClear()
    const view = render(
      <ValidationCard
        execution={fixture({
          status: 'running',
          paused: true,
          blocker: null,
          correction_cycles: 3,
        })}
      />
    )
    fireEvent.click(
      view.getByRole('button', { name: 'Reprendre la validation' })
    )
    expect(control).toHaveBeenCalledWith(
      { executionId: 'v1', action: 'resume' },
      expect.anything()
    )
  })
})

it('preserves the diagnostic attached to the French correction limit', () => {
  const blocker =
    'Limite de correction atteinte : 3 tentatives maximum ou 2 tentatives sans progrès vérifié. Une décision explicite est nécessaire pour poursuivre. Dernier résultat : test Elm de visibilité IA en échec.'
  const view = render(
    <ValidationCard
      execution={fixture({
        step: 'correction',
        status: 'blocked',
        correction_cycles: 3,
        blocker,
      })}
    />
  )
  expect(view.getByRole('alert')).toHaveTextContent(blocker)
  expect(
    view.queryByRole('button', { name: 'Reprendre la validation' })
  ).not.toBeInTheDocument()
})

it('keeps legacy non-superseded history read-only and resumes the exact current execution', () => {
  control.mockClear()
  query.mockReturnValue({
    data: [
      fixture({ id: 'failed-old', status: 'failed', superseded_by: 'current' }),
      fixture({ id: 'current', status: 'running' }),
    ],
    isLoading: false,
    isError: false,
  })
  const view = render(
    <AiPipelineValidationPanel projectId="p1" enabled worktreeId="w1" />
  )
  fireEvent.click(view.getByText('Exécutions précédentes (1)'))
  expect(
    view.queryByRole('button', { name: 'Reprendre la validation' })
  ).not.toBeInTheDocument()
  expect(
    view.queryByRole('button', { name: 'Nouvelle validation…' })
  ).not.toBeInTheDocument()
  fireEvent.click(view.getByRole('button', { name: 'Mettre en pause' }))
  expect(control).toHaveBeenCalledWith(
    { executionId: 'current', action: 'pause' },
    expect.anything()
  )
})

it('disables ambiguous legacy current executions rather than guessing ownership', () => {
  control.mockClear()
  query.mockReturnValue({
    data: [
      fixture({ id: 'correction-failed', status: 'failed' }),
      fixture({
        id: 'review-new',
        status: 'running',
        created_at: '2026-10-08',
      }),
    ],
    isLoading: false,
    isError: false,
  })
  const view = render(
    <AiPipelineValidationPanel projectId="p1" enabled worktreeId="w1" />
  )
  fireEvent.click(view.getByText('Exécutions précédentes (1)'))
  expect(
    view.getByText(/Plusieurs validations courantes existent/)
  ).toBeInTheDocument()
  expect(
    view.queryByRole('button', { name: 'Reprendre la validation' })
  ).not.toBeInTheDocument()
  expect(
    view.queryByRole('button', { name: 'Mettre en pause' })
  ).not.toBeInTheDocument()
  expect(
    view.queryByRole('button', { name: 'Nouvelle validation…' })
  ).not.toBeInTheDocument()
  expect(control).not.toHaveBeenCalled()
})

it('does not label an ambiguous current card as running', () => {
  const view = render(
    <ValidationCard execution={fixture({ status: 'running' })} ambiguous />
  )
  expect(view.getByRole('status')).toHaveTextContent('Suivi ambigu')
  expect(view.getByRole('status')).not.toHaveTextContent('En cours')
})

it('keeps stale cached execution read-only instead of showing a live resumable cycle', () => {
  query.mockReturnValue({
    data: [fixture()],
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  })
  const view = render(
    <AiPipelineValidationPanel projectId="p1" enabled worktreeId="w1" />
  )
  expect(view.getByText(/Suivi périmé/)).toBeInTheDocument()
  expect(
    view.queryByRole('button', { name: 'Reprendre la validation' })
  ).not.toBeInTheDocument()
})

it('explains the expected action and discloses technical identifiers only with proofs', () => {
  const view = render(
    <ValidationCard execution={fixture({ status: 'running', blocker: null })} />
  )
  expect(
    view.getByText(/Aucune action attendue de ta part/)
  ).toBeInTheDocument()
  expect(view.queryByText('Exécution v1')).not.toBeInTheDocument()
  fireEvent.click(
    view.getByRole('button', { name: 'Voir les preuves et limites' })
  )
  expect(view.getByText('Exécution v1')).toBeInTheDocument()
  expect(
    view.getByRole('button', { name: 'Masquer les preuves' })
  ).toHaveAttribute('aria-controls', 'proofs-v1')
})

it.each(['running', 'waiting', 'pending'] as const)(
  'keeps an old blocker as neutral provenance while the cycle is %s',
  status => {
    const view = render(<ValidationCard execution={fixture({ status })} />)
    expect(view.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.getByText('Dernier point signalé')).toBeInTheDocument()
    expect(view.getByText('Accès indisponible')).toBeInTheDocument()
  }
)
