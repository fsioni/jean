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
    expect(view.getByText('Ticket t1 · PR #42')).toBeInTheDocument()
    expect(
      view.getByRole('button', { name: 'Validation existante' })
    ).toBeDisabled()
    fireEvent.click(
      view.getByRole('button', { name: 'Reprendre la validation' })
    )
    expect(control).toHaveBeenCalledWith(
      { executionId: 'v1', action: 'resume' },
      expect.anything()
    )
  })
})
