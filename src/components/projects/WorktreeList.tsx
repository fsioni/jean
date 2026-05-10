import { useCallback, useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Worktree } from '@/types/projects'
import type { WorktreeSessions } from '@/types/chat'
import { invoke } from '@/lib/transport'
import { chatQueryKeys } from '@/services/chat'
import { isTauri } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import {
  compareWorktreesForCanvasSort,
  getWorktreeLastActivity,
} from './worktree-sort-utils'
import { WorktreeItem } from './WorktreeItem'
import { WorktreeItemSkeleton } from './WorktreeItemSkeleton'

interface SortableWorktreeProps {
  worktree: Worktree
  projectId: string
  projectPath: string
  defaultBranch: string
  disabled: boolean
}

function SortableWorktree({
  worktree,
  projectId,
  projectPath,
  defaultBranch,
  disabled,
}: SortableWorktreeProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: worktree.id,
    disabled,
  })

  const style: React.CSSProperties = {
    // Use Translate instead of Transform to avoid scale which affects text rendering
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
  }

  // Pending or deleting worktrees show skeleton
  if (worktree.status === 'pending' || worktree.status === 'deleting') {
    return <WorktreeItemSkeleton worktree={worktree} />
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={disabled ? '' : isDragging ? 'cursor-grabbing' : 'cursor-grab'}
    >
      <WorktreeItem
        worktree={worktree}
        projectId={projectId}
        projectPath={projectPath}
        defaultBranch={defaultBranch}
      />
    </div>
  )
}

interface WorktreeListProps {
  projectId: string
  projectPath: string
  worktrees: Worktree[]
  defaultBranch: string
}

export function WorktreeList({
  projectId,
  projectPath,
  worktrees,
  defaultBranch,
}: WorktreeListProps) {
  const worktreeSortMode = useProjectsStore(
    state =>
      state.projectCanvasSettings[projectId]?.worktreeSortMode ?? 'created'
  )

  const pendingWorktrees = useMemo(
    () => worktrees.filter(w => w.status === 'pending'),
    [worktrees]
  )
  const readyWorktrees = useMemo(
    () =>
      worktrees.filter(
        w => !w.status || w.status === 'ready' || w.status === 'error'
      ),
    [worktrees]
  )

  const sessionQueries = useQueries({
    queries: readyWorktrees.map(wt => ({
      queryKey: [...chatQueryKeys.sessions(wt.id), 'with-counts'],
      queryFn: async (): Promise<WorktreeSessions> => {
        if (!isTauri() || !wt.id || !wt.path) {
          return {
            worktree_id: wt.id,
            sessions: [],
            active_session_id: null,
            version: 2,
          }
        }
        return invoke<WorktreeSessions>('get_sessions', {
          worktreeId: wt.id,
          worktreePath: wt.path,
          includeMessageCounts: true,
        })
      },
      enabled: !!wt.id && !!wt.path,
    })),
  })

  const sessionsFingerprint = sessionQueries
    .map(q => `${q.data?.worktree_id}:${q.dataUpdatedAt}:${q.isLoading}`)
    .join('|')

  const sessionsByWorktreeId = useMemo(() => {
    const map = new Map<string, WorktreeSessions>()
    for (const query of sessionQueries) {
      if (query.data?.worktree_id) {
        map.set(query.data.worktree_id, query.data)
      }
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsFingerprint])

  // Match ProjectCanvasView ordering: pending first, then base session first,
  // then selected canvas sort mode using session last activity when requested.
  const sortedWorktrees = useMemo(() => {
    const latestActivityByWorktreeId = new Map<string, number>()
    for (const worktree of pendingWorktrees) {
      latestActivityByWorktreeId.set(worktree.id, worktree.created_at)
    }
    for (const worktree of readyWorktrees) {
      const sessions = sessionsByWorktreeId.get(worktree.id)?.sessions ?? []
      latestActivityByWorktreeId.set(
        worktree.id,
        getWorktreeLastActivity(sessions, worktree.created_at)
      )
    }

    const sortedPending = [...pendingWorktrees].sort(
      (a, b) => b.created_at - a.created_at
    )
    const sortedReady = [...readyWorktrees].sort((a, b) =>
      compareWorktreesForCanvasSort(
        a,
        b,
        latestActivityByWorktreeId,
        worktreeSortMode
      )
    )

    return [...sortedPending, ...sortedReady]
  }, [pendingWorktrees, readyWorktrees, sessionsByWorktreeId, worktreeSortMode])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = useCallback((_event: DragEndEvent) => {
    // Sidebar order is derived from the ProjectCanvasView sort setting.
    // Manual reordering is disabled so the sidebar cannot drift from canvas.
  }, [])

  // Get only the draggable worktree IDs for SortableContext
  const draggableIds: string[] = []

  return (
    <div className="ml-4 border-l border-border/40 py-0.5">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={draggableIds}
          strategy={verticalListSortingStrategy}
        >
          {sortedWorktrees.map(worktree => {
            return (
              <SortableWorktree
                key={worktree.id}
                worktree={worktree}
                projectId={projectId}
                projectPath={projectPath}
                defaultBranch={defaultBranch}
                disabled
              />
            )
          })}
        </SortableContext>
      </DndContext>
    </div>
  )
}
