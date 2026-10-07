import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
const convert = vi.fn((path: string) => `asset:${path}`)
vi.mock('@/lib/transport', () => ({
  convertFileSrc: (path: string) => convert(path),
}))
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}))
import { EvidenceArtifact } from './EvidenceArtifact'
const evidence = {
  id: 'e1',
  label: 'Signature enregistrée',
  kind: 'screenshot',
  value: '/private/validations/v1/signature.png',
  commit: 'abc',
  stale: false,
}
describe('private artifact previews', () => {
  it('previews a local screenshot with an accessible enlarged view', () => {
    const view = render(<EvidenceArtifact evidence={evidence} />)
    expect(
      view.getByRole('img', {
        name: 'Capture de recette : Signature enregistrée',
      })
    ).toHaveAttribute('src', 'asset:/private/validations/v1/signature.png')
    fireEvent.click(
      view.getByRole('button', {
        name: 'Agrandir la capture : Signature enregistrée',
      })
    )
    expect(
      view.getByRole('img', {
        name: 'Capture agrandie : Signature enregistrée',
      })
    ).toBeInTheDocument()
  })
  it.each([
    { kind: 'test', value: evidence.value },
    { kind: 'screenshot', value: 'https://example.com/image.png' },
    { kind: 'screenshot', value: 'data:image/png;base64,abc' },
    { kind: 'screenshot', value: 'relative.png' },
    { kind: 'screenshot', value: '/private/script.svg' },
  ])('never embeds non-image artifacts or external inputs: %j', extra => {
    const view = render(
      <EvidenceArtifact evidence={{ ...evidence, ...extra }} />
    )
    expect(view.queryByRole('img')).not.toBeInTheDocument()
  })
  it('offers path copying rather than embedding a PDF', () => {
    const view = render(
      <EvidenceArtifact
        evidence={{ ...evidence, kind: 'pdf', value: '/private/contract.pdf' }}
      />
    )
    expect(view.queryByRole('img')).not.toBeInTheDocument()
    expect(
      view.getByRole('button', { name: 'Copier le chemin de l’artefact' })
    ).toBeInTheDocument()
  })
})
