import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useRunAiPipelineValidationLab } from '@/services/ai-pipeline-validation-lab'

/** Deliberately independent of live credentials, projects and validation caches. */
export function AiPipelineValidationLab() {
  const [open, setOpen] = useState(false)
  const busy = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const run = useRunAiPipelineValidationLab()
  const report = run.data
  const allPassed =
    !!report &&
    report.isolated === true &&
    report.totalCount > 0 &&
    report.scenarios.length === report.totalCount &&
    report.passedCount === report.totalCount &&
    report.scenarios.every(
      s => s.passed && s.checks.length > 0 && s.checks.every(c => c.passed)
    )
  const launch = () => {
    if (busy.current) return
    busy.current = true
    run.mutate(undefined, {
      onSettled: () => {
        busy.current = false
      },
    })
  }
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        className="shrink-0 self-start text-xs text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Banc d’essai isolé
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          onCloseAutoFocus={event => {
            event.preventDefault()
            trigger.current?.focus()
          }}
          className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle>Banc d’essai isolé</DialogTitle>
            <DialogDescription>
              Teste le moteur, sa persistance et des fixtures hors ligne. Aucun
              ticket, worktree ou environnement réel n’est utilisé.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground">
                Une répétition technique, pas une recette réelle.
              </p>
              <p className="mt-1">
                Ne vérifie pas un agent réel ni tout le cycle de
                commandes/CI/preview. Aucun agent IA, appel CI ou preview
                externe. Les résultats ne prouvent ni la qualité d’un ticket ni
                le bon fonctionnement d’un déploiement.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={launch} disabled={run.isPending}>
                {run.isPending && (
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
                {run.isPending
                  ? 'Scénarios en cours…'
                  : run.isError
                    ? 'Réessayer les scénarios'
                    : 'Lancer les scénarios'}
              </Button>
              <span className="text-xs text-muted-foreground">
                Aucun lancement automatique.
              </span>
            </div>
            {run.isPending && (
              <p className="text-sm text-muted-foreground" role="status">
                Exécution des fixtures isolées…
              </p>
            )}
            {run.isError && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              >
                Banc d’essai indisponible :{' '}
                {run.error instanceof Error
                  ? run.error.message
                  : String(run.error)}
              </p>
            )}
            {report && !run.isPending && !run.isError && (
              <section
                aria-label="Résultats du banc d’essai"
                className="space-y-3"
              >
                <div
                  role="status"
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  {allPassed ? (
                    <CheckCircle2
                      className="size-5 shrink-0 text-green-600 dark:text-green-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <AlertTriangle
                      className="size-5 shrink-0 text-orange-600 dark:text-orange-400"
                      aria-hidden="true"
                    />
                  )}
                  <div>
                    <p className="text-sm font-semibold">
                      {report.passedCount}/{report.totalCount} scénarios réussis
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {allPassed
                        ? 'Contrôles isolés réussis.'
                        : 'Des contrôles restent en échec ou non confirmés.'}{' '}
                      Aucun résultat live.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Ces résultats ne confirment pas une orchestration
                      opérationnelle.
                    </p>
                  </div>
                </div>
                {report.scenarios.map(scenario => (
                  <details
                    key={scenario.id}
                    className="group rounded-lg border border-border bg-background"
                    open={!scenario.passed}
                  >
                    <summary className="cursor-pointer px-3 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="font-medium">{scenario.label}</span>
                      <span
                        className={`ml-2 text-xs ${scenario.passed ? 'text-muted-foreground' : 'font-semibold text-destructive'}`}
                      >
                        {scenario.passed ? 'Réussi' : 'Échec'}
                      </span>
                    </summary>
                    <div className="space-y-3 border-t border-border px-3 py-3">
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {scenario.summary}
                      </p>
                      <ul
                        aria-label={`Contrôles : ${scenario.label}`}
                        className="space-y-1.5"
                      >
                        {scenario.checks.map((check, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-2 text-xs"
                          >
                            {check.passed ? (
                              <CheckCircle2
                                className="size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                            ) : (
                              <AlertTriangle
                                className="size-3.5 shrink-0 text-destructive"
                                aria-hidden="true"
                              />
                            )}
                            <span>
                              {check.label} —{' '}
                              <span
                                className={
                                  check.passed
                                    ? 'text-muted-foreground'
                                    : 'font-medium text-destructive'
                                }
                              >
                                {check.passed ? 'Validé' : 'Échec'}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                      {scenario.transitions.length > 0 && (
                        <div>
                          <h4 className="mb-2 text-xs font-semibold">
                            Trace des transitions
                          </h4>
                          <ol
                            aria-label={`Trace : ${scenario.label}`}
                            className="space-y-2 border-l border-border pl-3"
                          >
                            {scenario.transitions.map((transition, i) => (
                              <li key={i} className="text-xs">
                                <div className="flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
                                  <span>{transition.step}</span>
                                  <span>{transition.status}</span>
                                </div>
                                <p className="mt-0.5 break-words leading-relaxed">
                                  {transition.message}
                                </p>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}
                    </div>
                  </details>
                ))}
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
