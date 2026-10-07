import { useMutation } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import type { ValidationLabReport } from '@/types/ai-pipeline-validation-lab'

/** User-triggered only. No live project, ticket or worktree arguments. */
export function useRunAiPipelineValidationLab() {
  return useMutation({
    mutationFn: () =>
      invoke<ValidationLabReport>('run_ai_pipeline_validation_lab', {}),
    retry: false,
  })
}
