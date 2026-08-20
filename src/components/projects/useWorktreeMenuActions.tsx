import { useState, useCallback } from 'react'
import { isBaseSession, type Worktree } from '@/types/projects'
import {
  useArchiveWorktree,
  useCloseBaseSession,
  useDeleteWorktree,
  useOpenWorktreeInFinder,
  useOpenWorktreeInTerminal,
  useOpenWorktreeInEditor,
  useRunScriptEntries,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { useSessions } from '@/services/chat'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { startManagedRunForWorkspace } from '@/services/managed-runs'
import { toast } from 'sonner'

interface UseWorktreeMenuActionsProps {
  worktree: Worktree
  projectId: string
}

export function useWorktreeMenuActions({
  worktree,
  projectId,
}: UseWorktreeMenuActionsProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const archiveWorktree = useArchiveWorktree()
  const closeBaseSession = useCloseBaseSession()
  const deleteWorktree = useDeleteWorktree()
  const openInFinder = useOpenWorktreeInFinder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()
  const { data: runScripts = [] } = useRunScriptEntries(worktree.path)
  const { data: preferences } = usePreferences()
  const { data: sessionsData } = useSessions(worktree.id, worktree.path)
  const isBase = isBaseSession(worktree)

  const hasMessages = sessionsData?.sessions?.some(
    session => session.messages.length > 0
  )

  const handleRun = useCallback(() => {
    const first = runScripts.find(script => script.isDefault) ?? runScripts[0]
    if (first) {
      useUIStore.getState().setSessionChatModalOpen(true, worktree.id)
      useTerminalStore.getState().setModalTerminalOpen(worktree.id, true)
      void startManagedRunForWorkspace({
        projectId,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        script: first,
      }).catch(error => toast.error(`Failed to start Run: ${String(error)}`))
    }
  }, [projectId, runScripts, worktree.id, worktree.path])

  const handleRunCommand = useCallback(
    (script: (typeof runScripts)[number]) => {
      useUIStore.getState().setSessionChatModalOpen(true, worktree.id)
      useTerminalStore.getState().setModalTerminalOpen(worktree.id, true)
      void startManagedRunForWorkspace({
        projectId,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        script,
      }).catch(error => toast.error(`Failed to start Run: ${String(error)}`))
    },
    [projectId, worktree.id, worktree.path]
  )

  const handleOpenTerminalPanel = useCallback(() => {
    useTerminalStore.getState().addTerminal(worktree.id)
  }, [worktree.id])

  const handleOpenInFinder = useCallback(() => {
    openInFinder.mutate(worktree.path)
  }, [openInFinder, worktree.path])

  const handleOpenInTerminal = useCallback(() => {
    openInTerminal.mutate({
      worktreePath: worktree.path,
      terminal: preferences?.terminal,
    })
  }, [openInTerminal, worktree.path, preferences?.terminal])

  const handleOpenInEditor = useCallback(() => {
    openInEditor.mutate({
      worktreePath: worktree.path,
      editor: preferences?.editor,
    })
  }, [openInEditor, worktree.path, preferences?.editor])

  const handleArchiveOrClose = useCallback(() => {
    if (isBase) {
      closeBaseSession.mutate({ worktreeId: worktree.id, projectId })
    } else if (preferences?.removal_behavior === 'delete') {
      deleteWorktree.mutate({ worktreeId: worktree.id, projectId })
    } else {
      archiveWorktree.mutate({ worktreeId: worktree.id, projectId })
    }
  }, [
    isBase,
    closeBaseSession,
    archiveWorktree,
    deleteWorktree,
    worktree.id,
    projectId,
    preferences?.removal_behavior,
  ])

  const handleDelete = useCallback(() => {
    deleteWorktree.mutate({ worktreeId: worktree.id, projectId })
    setShowDeleteConfirm(false)
  }, [deleteWorktree, worktree.id, projectId])

  return {
    // State
    showDeleteConfirm,
    setShowDeleteConfirm,
    isBase,
    hasMessages,
    runScripts,
    preferences,

    // Handlers
    handleRun,
    handleRunCommand,
    handleOpenTerminalPanel,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleArchiveOrClose,
    handleDelete,
  }
}
