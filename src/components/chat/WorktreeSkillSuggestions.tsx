import { useSession } from '@/services/chat'
import { readSkillConversationContext } from './skill-conversation-context'
import { useQuery } from '@tanstack/react-query'
import { getGitDiff } from '@/services/git-status'
import { useEffect, useState } from 'react'
import { useAllBackendSkills } from '@/services/skills'
import { useProjects, useWorktrees } from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { generateId } from '@/lib/uuid'
import type { ExecutionMode, PendingSkill } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
import { suggestWorktreeSkills } from './skill-suggestions'

const labels: Record<string, string> = {
  'ticket-fix': 'Corriger les écarts',
  'clickup-review': 'Revoir le ticket',
  'feature-flow': 'Publier le travail',
  'repair-jenkins-branch': 'Diagnostiquer la CI',
  'preview-acceptance': 'Recetter la preview',
}

export function WorktreeSkillSuggestions({
  projectId,
  worktreePath,
  sessionId,
  backend,
  installedBackends,
  disabled,
  executionMode,
  onSelect,
}: {
  projectId?: string | null
  worktreePath?: string
  sessionId?: string
  backend?: CliBackend
  installedBackends?: CliBackend[]
  disabled: boolean
  executionMode?: ExecutionMode
  onSelect: (skill: PendingSkill) => void
}) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  const { data: projects } = useProjects()
  const project = projects?.find(project => project.id === projectId)
  const enabled = project?.name.toLowerCase() === 'planexpo'
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now() / 1000), 60_000)
    return () => clearInterval(timer)
  }, [enabled])
  const { data: worktrees } = useWorktrees(projectId ?? null, { enabled })
  const groups = useAllBackendSkills(worktreePath, installedBackends)
  const pending = useChatStore(state =>
    sessionId ? state.pendingSkills[sessionId] : undefined
  )
  const worktree = worktrees?.find(worktree => worktree.path === worktreePath)
  const { data: session } = useSession(
    enabled ? (sessionId ?? null) : null,
    worktree?.id ?? null,
    worktreePath ?? null
  )
  const context = readSkillConversationContext(session?.messages ?? [])
  const hasDirtyLines = Boolean(
    worktree &&
    (worktree.cached_uncommitted_added ?? 0) +
      (worktree.cached_uncommitted_removed ?? 0) >
      0
  )
  const changes = useQuery({
    queryKey: [
      'skill-suggestion-changes',
      worktreePath,
      worktree?.cached_status_at,
    ],
    queryFn: () => {
      if (!worktreePath) throw new Error('Worktree absent')
      return getGitDiff(worktreePath, 'uncommitted')
    },
    enabled: enabled && Boolean(worktreePath) && hasDirtyLines && !disabled,
    staleTime: 30_000,
    retry: false,
  })
  const dirtyKnown = !hasDirtyLines || Boolean(changes.data)
  const hasLocalWork =
    hasDirtyLines &&
    (changes.data?.files.some(
      file =>
        file.path !== 'jean.json' ||
        (file.old_path && file.old_path !== 'jean.json')
    ) ??
      false)
  if (
    !enabled ||
    !sessionId ||
    !worktree ||
    disabled ||
    ['closed', 'merged'].includes(worktree.cached_pr_status ?? '')
  )
    return null

  const names = suggestWorktreeSkills(
    {
      hasPr: Boolean(worktree.pr_number),
      localChangesKnown: dirtyKnown,
      dirty: hasLocalWork || (worktree.cached_unpushed_count ?? 0) > 0,
      ci: worktree.cached_check_status,
      fresh: Boolean(
        dirtyKnown &&
        worktree.cached_status_at &&
        now >= worktree.cached_status_at &&
        now - worktree.cached_status_at < 300
      ),
    },
    context
  )
  const available = groups
    .filter(group => group.backend === backend)
    .flatMap(group => group.skills)
  const suggestions = names.flatMap(name => {
    // Only the actual project-scoped skill, never a global namesake.
    const skill = available.find(
      skill => skill.name === name && skill.path.startsWith(`${worktreePath}/`)
    )
    return skill && !pending?.some(item => item.path === skill.path)
      ? [skill]
      : []
  })
  const actionSkills = new Set([
    'ticket-fix',
    'feature-flow',
    'repair-jenkins-branch',
    'relance-jenkins-push-vide',
    'preview-acceptance',
  ])
  const planActionSelected =
    executionMode === 'plan' &&
    pending?.some(skill => actionSkills.has(skill.name))
  if (!suggestions.length && !planActionSelected) return null
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-1.5"
      aria-label="Skills suggérés"
    >
      {planActionSelected && (
        <p
          role="status"
          className="w-full text-xs text-amber-700 dark:text-amber-400"
        >
          Ce skill doit agir : passez de Plan à Build avant de l’envoyer.
        </p>
      )}
      {suggestions.length > 0 && (
        <span className="mr-1 text-xs text-muted-foreground">
          Pour la suite
        </span>
      )}
      {suggestions.map(skill => (
        <button
          key={skill.path}
          type="button"
          className="rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={`Sélectionner ${skill.name} — aucun envoi automatique`}
          onClick={() =>
            onSelect({ id: generateId(), name: skill.name, path: skill.path })
          }
        >
          {labels[skill.name] ?? skill.name}
        </button>
      ))}
    </div>
  )
}
