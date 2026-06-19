import React, { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Link2, Link2Off, Search, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ClickUpTask } from '@/types/clickup'
import {
  listClickUpTasks,
  useClickUpConfig,
  useClearClickUpLink,
  useHasClickUpAccess,
  useResolvedClickUpTaskId,
  useSetClickUpLink,
} from '@/services/clickup'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import { ClickUpTaskCard } from './ClickUpTaskCard'

interface ClickUpTaskTabProps {
  worktreeId: string | null
  projectId: string | null
}

/**
 * Tab to view and manage the ClickUp task linked to a worktree: shows the
 * linked task, lets you enter a task id manually, or browse the configured
 * Planexpo list and pick one.
 */
export const ClickUpTaskTab: React.FC<ClickUpTaskTabProps> = ({
  worktreeId,
  projectId,
}) => {
  const hasAccess = useHasClickUpAccess(projectId)
  const { data: config } = useClickUpConfig()
  const { data: linkedTaskId } = useResolvedClickUpTaskId(worktreeId)
  const setLink = useSetClickUpLink()
  const clearLink = useClearClickUpLink()

  const [manualId, setManualId] = useState('')
  const [search, setSearch] = useState('')
  const [tasks, setTasks] = useState<ClickUpTask[] | null>(null)
  const [loadingTasks, setLoadingTasks] = useState(false)

  const handleLink = useCallback(
    (taskId: string) => {
      if (!worktreeId || !taskId.trim()) return
      setLink.mutate(
        { worktreeId, taskId: taskId.trim() },
        {
          onSuccess: () => {
            setManualId('')
            toast.success(`Tâche CU-${taskId.trim()} liée`)
          },
          onError: e => toast.error(`Échec du lien : ${e}`),
        }
      )
    },
    [worktreeId, setLink]
  )

  const handleUnlink = useCallback(() => {
    if (!worktreeId) return
    clearLink.mutate(
      { worktreeId },
      {
        onSuccess: () => toast.success('Tâche déliée'),
        onError: e => toast.error(`Échec : ${e}`),
      }
    )
  }, [worktreeId, clearLink])

  const handleBrowse = useCallback(async () => {
    setLoadingTasks(true)
    try {
      const result = await listClickUpTasks(undefined, projectId ?? undefined)
      setTasks(result)
    } catch (e) {
      toast.error(`Échec du chargement de la liste : ${e}`)
    } finally {
      setLoadingTasks(false)
    }
  }, [projectId])

  const filteredTasks = useMemo(() => {
    if (!tasks) return []
    const q = search.toLowerCase().trim()
    if (!q) return tasks
    return tasks.filter(
      t => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)
    )
  }, [tasks, search])

  if (!hasAccess) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <ClickUpIcon size={24} />
        <p>
          Aucun token ClickUp configuré.
          <br />
          Ajoute-le dans Réglages → Intégrations.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* Linked task */}
      {linkedTaskId ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            Tâche liée
          </div>
          <ClickUpTaskCard worktreeId={worktreeId} projectId={projectId} />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={handleUnlink}
            disabled={clearLink.isPending}
          >
            {clearLink.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Link2Off className="h-3.5 w-3.5" />
            )}
            Délier
          </Button>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Aucune tâche liée. Lie-en une via son id ou en parcourant la liste.
        </div>
      )}

      {/* Manual link by id */}
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground">
          Lier par id
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="86caa8btx"
            value={manualId}
            onChange={e => setManualId(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleLink(manualId)
            }}
            className="h-8 flex-1 text-sm font-mono"
          />
          <Button
            size="sm"
            className="h-8 gap-1"
            onClick={() => handleLink(manualId)}
            disabled={!manualId.trim() || setLink.isPending}
          >
            <Link2 className="h-3.5 w-3.5" />
            Lier
          </Button>
        </div>
      </div>

      {/* Browse configured list */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">
            Parcourir la liste Planexpo
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={handleBrowse}
            disabled={loadingTasks || !config?.planexpoListId}
          >
            {loadingTasks ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Charger
          </Button>
        </div>

        {!config?.planexpoListId && (
          <div className="text-xs text-muted-foreground">
            Configure une liste Planexpo dans Réglages → Intégrations pour
            parcourir les tâches.
          </div>
        )}

        {tasks && (
          <>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filtrer…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 pl-7 text-sm"
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {filteredTasks.length === 0 ? (
                <div className="py-3 text-center text-xs text-muted-foreground">
                  Aucune tâche.
                </div>
              ) : (
                filteredTasks.map(task => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => handleLink(task.id)}
                    disabled={setLink.isPending}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                  >
                    {task.status?.color && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: task.status.color }}
                      />
                    )}
                    <span className="truncate">{task.name}</span>
                    {linkedTaskId === task.id && (
                      <Link2 className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
