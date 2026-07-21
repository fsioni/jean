import { useCallback, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Loader2,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useJenkinsFailureReport } from '@/services/jenkins'
import { useSendFailureToAgent } from '@/components/mission-control/useSendFailureToAgent'
import type { Project, Worktree } from '@/types/projects'

/** Log lines rendered before the "show everything" toggle. */
const COLLAPSED_LOG_LINES = 14

/**
 * The "why did it fail" panel: failing stage, named failing tests and the
 * cleaned tail of the failing job's log — plus the one-click handoff to the
 * agent.
 *
 * Fetched on demand (mounting this panel IS the demand), because the backend
 * walks several Jenkins endpoints to assemble it.
 */
export function FailureReportPanel({
  project,
  worktree,
  prId,
  buildNumber,
}: {
  project: Project
  worktree: Worktree
  prId: string
  /** Keys the cache — a new build never shows the previous build's failure. */
  buildNumber: number | null
}) {
  const {
    data: report,
    isLoading,
    error,
  } = useJenkinsFailureReport(
    project.id,
    worktree.id,
    buildNumber,
    prId,
    worktree.branch,
    { enabled: true }
  )
  const sendToAgent = useSendFailureToAgent()
  const [expanded, setExpanded] = useState(false)
  const [sending, setSending] = useState(false)

  const handleCopy = useCallback(() => {
    if (!report) return
    const tests = report.failedTests
      .map(
        t => `${t.className} :: ${t.name}${t.message ? `\n${t.message}` : ''}`
      )
      .join('\n')
    writeText([tests, report.logExcerpt].filter(Boolean).join('\n\n'))
      .then(() => toast.success('Erreur copiée'))
      .catch(() => toast.error('Copie impossible'))
  }, [report])

  const handleSend = useCallback(async () => {
    if (!report) return
    setSending(true)
    try {
      await sendToAgent({ project, worktree, prId, report })
    } finally {
      setSending(false)
    }
  }, [report, sendToAgent, project, worktree, prId])

  const handleOpenConsole = useCallback(() => {
    if (report?.consoleUrl) openUrl(report.consoleUrl)
  }, [report?.consoleUrl])

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-1.5 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Analyse de l&apos;échec…
      </div>
    )
  }

  if (error || !report) {
    return (
      <div className="flex items-center gap-2 px-1.5 py-2 text-xs text-muted-foreground">
        <AlertTriangle className="size-3.5" />
        Diagnostic indisponible ({String(error ?? 'aucun rapport')})
      </div>
    )
  }

  const logLines = report.logExcerpt ? report.logExcerpt.split('\n') : []
  const shownLines = expanded ? logLines : logLines.slice(-COLLAPSED_LOG_LINES)
  const hiddenCount = logLines.length - shownLines.length
  const hasContent = logLines.length > 0 || report.failedTests.length > 0

  return (
    <div className="mt-1.5 rounded-md border border-red-500/25 bg-red-500/[0.04] p-2">
      {/* What broke — stated in words, never by color alone */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <XCircle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
        <span className="font-medium text-foreground">
          {report.stage ?? 'Échec du pipeline'}
        </span>
        {report.downstreamJob && (
          <span className="text-muted-foreground">
            · {report.downstreamJob} #{report.downstreamNumber}
          </span>
        )}
        {report.failedTestCount > 0 && (
          <span className="text-muted-foreground">
            · {report.failedTestCount} test
            {report.failedTestCount > 1 ? 's' : ''} en échec
          </span>
        )}
      </div>

      {/* Named failing tests */}
      {report.failedTests.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {report.failedTests.map((test, i) => (
            <li key={`${test.className}-${test.name}-${i}`} className="text-xs">
              <span className="font-mono text-foreground">{test.name}</span>
              {test.className && test.className !== test.name && (
                <span className="ml-1 text-muted-foreground">
                  ({test.className})
                </span>
              )}
              {test.message && (
                <div className="mt-0.5 whitespace-pre-wrap break-words pl-2 font-mono text-[11px] leading-snug text-muted-foreground">
                  {test.message}
                </div>
              )}
            </li>
          ))}
          {report.failedTestCount > report.failedTests.length && (
            <li className="text-[11px] text-muted-foreground">
              + {report.failedTestCount - report.failedTests.length} autre
              {report.failedTestCount - report.failedTests.length > 1
                ? 's'
                : ''}{' '}
              sur Jenkins
            </li>
          )}
        </ul>
      )}

      {/* Log tail */}
      {logLines.length > 0 && (
        <>
          <pre
            className={cn(
              'mt-1.5 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] leading-snug text-foreground'
            )}
          >
            {shownLines.join('\n')}
          </pre>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Afficher les {hiddenCount} lignes précédentes
            </button>
          )}
        </>
      )}

      {!hasContent && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Jenkins n&apos;expose ni test en échec ni log exploitable pour ce
          build.
        </p>
      )}

      {/* Actions */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          onClick={handleSend}
          disabled={sending || !hasContent}
          title="Ouvrir une session Jean avec cette erreur et lancer la correction"
        >
          {sending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          Corriger avec Jean
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          disabled={!hasContent}
        >
          <Copy className="size-3.5" />
          Copier
        </Button>
        {report.consoleUrl && (
          <Button variant="ghost" size="sm" onClick={handleOpenConsole}>
            <ExternalLink className="size-3.5" />
            Console Jenkins
          </Button>
        )}
      </div>
    </div>
  )
}

export default FailureReportPanel
