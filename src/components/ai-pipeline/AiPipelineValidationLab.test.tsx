import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ValidationLabReport } from '@/types/ai-pipeline-validation-lab'
const invoke = vi.fn()
vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))
import { AiPipelineValidationLab } from './AiPipelineValidationLab'

const report: ValidationLabReport = {
  isolated: true,
  passedCount: 1,
  totalCount: 2,
  scenarios: [
    {
      id: 'resume',
      label: 'Reprise après interruption',
      passed: true,
      summary: 'État restauré depuis les fixtures.',
      checks: [{ label: 'Révision conservée', passed: true }],
      transitions: [
        {
          step: 'review',
          status: 'blocked',
          message: 'Réconciliation nécessaire',
        },
      ],
    },
    {
      id: 'proof',
      label: 'Preuve obligatoire',
      passed: false,
      summary: 'Un contrôle ne passe pas.',
      checks: [{ label: 'Preuve présente', passed: false }],
      transitions: [
        { step: 'acceptance', status: 'blocked', message: 'Preuve manquante' },
      ],
    },
  ],
}
function setup() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <AiPipelineValidationLab />
    </QueryClientProvider>
  )
  fireEvent.click(view.getByRole('button', { name: 'Banc d’essai isolé' }))
  return view
}
beforeEach(() => {
  invoke.mockReset()
})
describe('isolated validation lab', () => {
  it('opens an accessible offline dialog without auto-running or requiring a project', () => {
    const view = setup()
    expect(
      view.getByRole('dialog', { name: 'Banc d’essai isolé' })
    ).toBeInTheDocument()
    expect(view.getByText(/Aucun agent IA, appel CI/)).toBeInTheDocument()
    expect(
      view.getByRole('button', { name: 'Lancer les scénarios' })
    ).toBeEnabled()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('restores focus to the launcher after closing the dialog', async () => {
    const view = setup()
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Banc d’essai isolé' })
      ).toHaveFocus()
    )
    expect(invoke).not.toHaveBeenCalled()
  })
  it('launches exactly one request and deduplicates immediate clicks while pending', async () => {
    let finish: ((report: ValidationLabReport) => void) | undefined
    invoke.mockImplementation(
      () =>
        new Promise<ValidationLabReport>(resolve => {
          finish = resolve
        })
    )
    const view = setup()
    const button = view.getByRole('button', { name: 'Lancer les scénarios' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledWith('run_ai_pipeline_validation_lab', {})
    await waitFor(() =>
      expect(
        view.getByRole('button', { name: 'Scénarios en cours…' })
      ).toBeDisabled()
    )
    finish?.(report)
    await waitFor(() =>
      expect(view.getByText('1/2 scénarios réussis')).toBeInTheDocument()
    )
  })
  it('shows individual failures, checks and transition trace without blanket success', async () => {
    invoke.mockResolvedValue(report)
    const view = setup()
    fireEvent.click(view.getByRole('button', { name: 'Lancer les scénarios' }))
    await waitFor(() =>
      expect(view.getByText('1/2 scénarios réussis')).toBeInTheDocument()
    )
    expect(view.getByText(/Des contrôles restent en échec/)).toBeInTheDocument()
    expect(
      view.queryByText('Contrôles isolés réussis.')
    ).not.toBeInTheDocument()
    expect(
      view.getByRole('list', { name: 'Contrôles : Preuve obligatoire' })
    ).toHaveTextContent('Preuve présente — Échec')
    expect(
      view.getByRole('list', { name: 'Trace : Preuve obligatoire' })
    ).toHaveTextContent('acceptanceblockedPreuve manquante')
    expect(
      view.getByText('Preuve obligatoire').closest('details')
    ).toHaveAttribute('open')
  })
  it('distinguishes successful isolated results from live validation', async () => {
    invoke.mockResolvedValue({
      ...report,
      totalCount: 1,
      passedCount: 1,
      scenarios: [report.scenarios[0]],
    })
    const view = setup()
    fireEvent.click(view.getByRole('button', { name: 'Lancer les scénarios' }))
    await waitFor(() =>
      expect(view.getByText('1/1 scénarios réussis')).toBeInTheDocument()
    )
    expect(
      view.getByText('Contrôles isolés réussis. Aucun résultat live.')
    ).toBeInTheDocument()
  })
  it('shows technical errors and allows explicit retry without auto-retry', async () => {
    invoke
      .mockRejectedValueOnce(new Error('Stockage temporaire indisponible'))
      .mockResolvedValueOnce(report)
    const view = setup()
    fireEvent.click(view.getByRole('button', { name: 'Lancer les scénarios' }))
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent(
        'Stockage temporaire indisponible'
      )
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    fireEvent.click(
      view.getByRole('button', { name: 'Réessayer les scénarios' })
    )
    await waitFor(() =>
      expect(view.getByText('1/2 scénarios réussis')).toBeInTheDocument()
    )
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})

it.each(['native desktop', 'web desktop', 'mobile'])(
  'qualifies successful isolated results in the shared %s surface',
  async surface => {
    // No platform branch: this actual component is shared by all three surfaces.
    vi.stubGlobal(
      '__TAURI_INTERNALS__',
      surface === 'native desktop' ? {} : undefined
    )
    vi.stubGlobal('innerWidth', surface === 'mobile' ? 390 : 1280)
    invoke.mockResolvedValue({
      ...report,
      totalCount: 1,
      passedCount: 1,
      scenarios: [report.scenarios[0]],
    })
    const view = setup()
    fireEvent.click(view.getByRole('button', { name: 'Lancer les scénarios' }))
    await waitFor(() =>
      expect(view.getByText('1/1 scénarios réussis')).toBeInTheDocument()
    )
    expect(
      view.getByText(
        /Ne vérifie pas un agent réel ni tout le cycle de commandes\/CI\/preview/
      )
    ).toBeInTheDocument()
    expect(
      view.getByText(
        'Ces résultats ne confirment pas une orchestration opérationnelle.'
      )
    ).toBeInTheDocument()
    vi.unstubAllGlobals()
  }
)

it.each([
  { ...report, totalCount: 0, passedCount: 0, scenarios: [] },
  {
    ...report,
    totalCount: 1,
    passedCount: 1,
    scenarios: [{ ...report.scenarios[0], checks: [] }],
  },
  {
    ...report,
    totalCount: 2,
    passedCount: 2,
    scenarios: [report.scenarios[0]],
  },
])(
  'does not label empty or inconsistent reports as successful controls',
  async result => {
    invoke.mockResolvedValue(result)
    const view = setup()
    fireEvent.click(view.getByRole('button', { name: 'Lancer les scénarios' }))
    await waitFor(() =>
      expect(
        view.getByLabelText('Résultats du banc d’essai')
      ).toBeInTheDocument()
    )
    expect(
      view.getByText(/Des contrôles restent en échec ou non confirmés/)
    ).toBeInTheDocument()
  }
)
