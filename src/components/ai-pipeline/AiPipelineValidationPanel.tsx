import { useAiPipelineValidations } from '@/services/ai-pipeline'
import { WorktreeValidationInline } from './WorktreeValidationInline'
export { ValidationCard, hasCurrentProof } from './ValidationCard'

export function AiPipelineValidationPanel({
  projectId,
  enabled,
  worktreeId,
  taskId,
  onOpenSession,
  querySnapshot,
  allowStart = false,
}: {
  projectId: string | null
  enabled: boolean
  worktreeId?: string | null
  taskId?: string | null
  allowStart?: boolean
  onOpenSession?: (sessionId: string) => void
  querySnapshot?: ReturnType<typeof useAiPipelineValidations>
}) {
  const ownQuery = useAiPipelineValidations(
    projectId,
    enabled && !querySnapshot
  )
  const query = querySnapshot ?? ownQuery
  if (!worktreeId) return null
  return (
    <WorktreeValidationInline
      worktreeId={worktreeId}
      query={query}
      projectId={projectId}
      taskId={taskId}
      allowStart={allowStart}
      onOpenSession={onOpenSession}
    />
  )
}
