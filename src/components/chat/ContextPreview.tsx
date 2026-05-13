import { useCallback } from 'react'
import { Bug, GitPullRequest, ShieldAlert, Siren } from 'lucide-react'
import { toast } from 'sonner'
import { DismissButton } from '@/components/ui/dismiss-button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  githubQueryKeys,
  removeAdvisoryContext,
  removeIssueContext,
  removePRContext,
  removeSecurityContext,
  useLoadedAdvisoryContexts,
  useLoadedIssueContexts,
  useLoadedPRContexts,
  useLoadedSecurityContexts,
} from '@/services/github'
import {
  linearQueryKeys,
  removeLinearIssueContext,
  useLoadedLinearIssueContexts,
} from '@/services/linear'
import { queryClient } from '@/lib/query-client'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { cn } from '@/lib/utils'

interface ContextPreviewProps {
  sessionId: string | null | undefined
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  projectId: string | null | undefined
  disabled?: boolean
  excludeIssueNumber?: number | null
  excludePrNumber?: number | null
  excludeSecurityAlertNumber?: number | null
  excludeAdvisoryGhsaId?: string | null
  excludeLinearIssueIdentifier?: string | null
}

interface ChipProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  title: string
  tone?: 'default' | 'warning' | 'danger'
  disabled?: boolean
  onRemove: () => void
}

function ContextChip({
  icon: Icon,
  label,
  title,
  tone = 'default',
  disabled,
  onRemove,
}: ChipProps) {
  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!disabled) onRemove()
    },
    [disabled, onRemove]
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'group relative flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-sm',
            tone === 'warning' &&
              'bg-amber-500/10 text-amber-700 dark:text-amber-300',
            tone === 'danger' && 'bg-red-500/10 text-red-700 dark:text-red-300'
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="font-mono text-xs text-muted-foreground">
            {label}
          </span>
          <span className="max-w-40 truncate">{title}</span>
          {!disabled && (
            <DismissButton
              tooltip="Remove context"
              onClick={handleRemove}
              className="ml-1"
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

async function invalidateContextQueries(sessionId?: string | null) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: githubQueryKeys.all }),
    queryClient.invalidateQueries({ queryKey: linearQueryKeys.all }),
    sessionId
      ? queryClient.invalidateQueries({ queryKey: ['sessions'] })
      : Promise.resolve(),
  ])
}

export function ContextPreview({
  sessionId,
  worktreeId,
  worktreePath,
  projectId,
  disabled,
  excludeIssueNumber,
  excludePrNumber,
  excludeSecurityAlertNumber,
  excludeAdvisoryGhsaId,
  excludeLinearIssueIdentifier,
}: ContextPreviewProps) {
  const { data: issues = [] } = useLoadedIssueContexts(
    sessionId ?? null,
    worktreeId ?? null
  )
  const { data: prs = [] } = useLoadedPRContexts(
    sessionId ?? null,
    worktreeId ?? null
  )
  const { data: securityAlerts = [] } = useLoadedSecurityContexts(
    sessionId ?? null,
    worktreeId ?? null
  )
  const { data: advisories = [] } = useLoadedAdvisoryContexts(
    sessionId ?? null,
    worktreeId ?? null
  )
  const { data: linearIssues = [] } = useLoadedLinearIssueContexts(
    sessionId ?? null,
    worktreeId ?? null,
    projectId ?? null
  )

  const visibleIssues = issues.filter(
    issue => issue.number !== excludeIssueNumber
  )
  const visiblePrs = prs.filter(pr => pr.number !== excludePrNumber)
  const visibleSecurityAlerts = securityAlerts.filter(
    alert => alert.number !== excludeSecurityAlertNumber
  )
  const visibleAdvisories = advisories.filter(
    advisory => advisory.ghsaId !== excludeAdvisoryGhsaId
  )
  const visibleLinearIssues = linearIssues.filter(
    issue => issue.identifier !== excludeLinearIssueIdentifier
  )

  const hasContexts =
    visibleIssues.length > 0 ||
    visiblePrs.length > 0 ||
    visibleSecurityAlerts.length > 0 ||
    visibleAdvisories.length > 0 ||
    visibleLinearIssues.length > 0

  if (!hasContexts) return null

  return (
    <div className="flex flex-wrap gap-2 px-4 py-2 md:px-6">
      {visibleIssues.map(issue => (
        <ContextChip
          key={`issue-${issue.number}`}
          icon={Bug}
          label={`#${issue.number}`}
          title={issue.title}
          disabled={disabled}
          onRemove={async () => {
            if (!sessionId || !worktreePath) return
            try {
              await removeIssueContext(sessionId, issue.number, worktreePath)
              await invalidateContextQueries(sessionId)
              toast.success(`Removed issue #${issue.number} from context`)
            } catch (error) {
              toast.error(`Failed to remove issue: ${error}`)
            }
          }}
        />
      ))}
      {visiblePrs.map(pr => (
        <ContextChip
          key={`pr-${pr.number}`}
          icon={GitPullRequest}
          label={`PR #${pr.number}`}
          title={pr.title}
          disabled={disabled}
          onRemove={async () => {
            if (!sessionId || !worktreePath) return
            try {
              await removePRContext(sessionId, pr.number, worktreePath)
              await invalidateContextQueries(sessionId)
              toast.success(`Removed PR #${pr.number} from context`)
            } catch (error) {
              toast.error(`Failed to remove PR: ${error}`)
            }
          }}
        />
      ))}
      {visibleSecurityAlerts.map(alert => (
        <ContextChip
          key={`security-${alert.number}`}
          icon={ShieldAlert}
          label={`Security #${alert.number}`}
          title={alert.summary}
          tone={alert.severity === 'critical' ? 'danger' : 'warning'}
          disabled={disabled}
          onRemove={async () => {
            if (!sessionId || !worktreePath) return
            try {
              await removeSecurityContext(sessionId, alert.number, worktreePath)
              await invalidateContextQueries(sessionId)
              toast.success(
                `Removed security alert #${alert.number} from context`
              )
            } catch (error) {
              toast.error(`Failed to remove security alert: ${error}`)
            }
          }}
        />
      ))}
      {visibleAdvisories.map(advisory => (
        <ContextChip
          key={`advisory-${advisory.ghsaId}`}
          icon={Siren}
          label={advisory.ghsaId}
          title={advisory.summary}
          tone={advisory.severity === 'critical' ? 'danger' : 'warning'}
          disabled={disabled}
          onRemove={async () => {
            if (!sessionId || !worktreePath) return
            try {
              await removeAdvisoryContext(
                sessionId,
                advisory.ghsaId,
                worktreePath
              )
              await invalidateContextQueries(sessionId)
              toast.success(`Removed advisory ${advisory.ghsaId} from context`)
            } catch (error) {
              toast.error(`Failed to remove advisory: ${error}`)
            }
          }}
        />
      ))}
      {visibleLinearIssues.map(issue => (
        <ContextChip
          key={`linear-${issue.identifier}`}
          icon={LinearIcon}
          label={issue.identifier}
          title={issue.title}
          disabled={disabled}
          onRemove={async () => {
            if (!sessionId || !projectId) return
            try {
              await removeLinearIssueContext(
                sessionId,
                projectId,
                issue.identifier
              )
              await invalidateContextQueries(sessionId)
              toast.success(
                `Removed Linear issue ${issue.identifier} from context`
              )
            } catch (error) {
              toast.error(`Failed to remove Linear issue: ${error}`)
            }
          }}
        />
      ))}
    </div>
  )
}
