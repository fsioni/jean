import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { copyToClipboard } from '@/lib/clipboard'
import { convertFileSrc } from '@/lib/transport'
import type { ValidationEvidence } from '@/types/ai-pipeline'

function isAbsoluteFilePath(value: string): boolean {
  return (
    !/[\r\n\0]/.test(value) &&
    (/^\/(?!\/)/.test(value) || /^[a-z]:[\\/]/i.test(value))
  )
}

/** Private backend-managed artifacts only; never load arbitrary agent URLs. */
export function EvidenceArtifact({
  evidence,
}: {
  evidence: ValidationEvidence
}) {
  const [open, setOpen] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const file = isAbsoluteFilePath(evidence.value)
  const screenshot =
    file &&
    evidence.kind === 'screenshot' &&
    /\.(png|jpe?g|webp|gif)$/i.test(evidence.value)
  const src = screenshot ? convertFileSrc(evidence.value) : undefined
  return (
    <div className="rounded-md bg-muted/50 p-2">
      <div className="font-medium">
        {evidence.label}{' '}
        {evidence.stale && (
          <span className="text-orange-700 dark:text-orange-400">
            · périmée
          </span>
        )}
      </div>
      {src && !unavailable && (
        <>
          <button
            type="button"
            className="mt-2 block overflow-hidden rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Agrandir la capture : ${evidence.label}`}
            onClick={() => setOpen(true)}
          >
            <img
              src={src}
              alt={`Capture de recette : ${evidence.label}`}
              loading="lazy"
              onError={() => setUnavailable(true)}
              className="max-h-40 w-full object-contain"
            />
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-5xl">
              <DialogHeader>
                <DialogTitle>{evidence.label}</DialogTitle>
              </DialogHeader>
              <img
                src={src}
                alt={`Capture agrandie : ${evidence.label}`}
                className="h-auto w-full object-contain"
              />
            </DialogContent>
          </Dialog>
        </>
      )}
      {unavailable && (
        <p className="mt-2 text-xs text-muted-foreground">
          Aperçu indisponible. Le chemin privé reste consultable ci-dessous.
        </p>
      )}
      <p className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">
        {evidence.value}
      </p>
      {file && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => {
            copyToClipboard(evidence.value)
              .then(() => toast.success('Chemin privé copié.'))
              .catch(e => toast.error(`Copie impossible : ${e}`))
          }}
        >
          Copier le chemin de l’artefact
        </Button>
      )}
    </div>
  )
}
