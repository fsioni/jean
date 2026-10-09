import type { useAiPipelineValidations } from '@/services/ai-pipeline'
import { WorktreeValidationInline } from './WorktreeValidationInline'

/** Permanent shared strip below the chat title; no menu or overlay. */
export function WorktreeValidationHeader({
  worktreeId,
  query,
  onOpenSession,
}: {
  worktreeId: string
  query: ReturnType<typeof useAiPipelineValidations>
  onOpenSession?: (sessionId: string) => void
}) {
  return (
    <WorktreeValidationInline
      worktreeId={worktreeId}
      query={query}
      onOpenSession={onOpenSession}
    />
  )
}
