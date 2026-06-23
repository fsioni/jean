import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import type {
  AiPipelineConfig,
  AiPipelinePr,
  AiPipelineReviewTask,
  FinishResult,
  ResumeResult,
  StepResult,
} from '@/types/ai-pipeline'
import { isTauri, projectsQueryKeys } from './projects'

function hasValue(value: string | null | undefined): boolean {
  return !!value?.trim()
}

// Query keys for the AI pipeline.
export const aiPipelineQueryKeys = {
  all: ['ai-pipeline'] as const,
  config: () => [...aiPipelineQueryKeys.all, 'config'] as const,
  prs: (projectId: string) =>
    [...aiPipelineQueryKeys.all, 'prs', projectId] as const,
  reviewTasks: (projectId: string) =>
    [...aiPipelineQueryKeys.all, 'review-tasks', projectId] as const,
}

/**
 * Read the persisted AI pipeline config (dashboard URL + label).
 */
export function useAiPipelineConfig() {
  return useQuery({
    queryKey: aiPipelineQueryKeys.config(),
    queryFn: async (): Promise<AiPipelineConfig> => {
      if (!isTauri()) return {}
      return invoke<AiPipelineConfig>('get_ai_pipeline_config')
    },
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: 1,
  })
}

/**
 * Whether a dashboard URL is configured (feature usable).
 */
export function useHasAiPipelineAccess(): boolean {
  const { data: config } = useAiPipelineConfig()
  return hasValue(config?.dashboardUrl)
}

/**
 * List the AI pipeline PRs for a project (scoped to its GitHub repo).
 */
export function useAiPipelinePrs(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const hasAccess = useHasAiPipelineAccess()
  const enabled = (options?.enabled ?? true) && !!projectId && hasAccess

  return useQuery({
    queryKey: aiPipelineQueryKeys.prs(projectId ?? ''),
    queryFn: async (): Promise<AiPipelinePr[]> => {
      if (!isTauri() || !projectId) return []
      return invoke<AiPipelinePr[]>('list_ai_pipeline_prs', { projectId })
    },
    enabled,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    retry: 1,
  })
}

/**
 * List the ClickUp `TO REVIEW` tickets ready to pick up (unassigned or mine),
 * joined with their PR in this project's repo. ClickUp is the source of truth.
 */
export function useAiPipelineReviewTasks(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const hasAccess = useHasAiPipelineAccess()
  const enabled = (options?.enabled ?? true) && !!projectId && hasAccess

  return useQuery({
    queryKey: aiPipelineQueryKeys.reviewTasks(projectId ?? ''),
    queryFn: async (): Promise<AiPipelineReviewTask[]> => {
      if (!isTauri() || !projectId) return []
      return invoke<AiPipelineReviewTask[]>('list_ai_pipeline_review_tasks', {
        projectId,
      })
    },
    enabled,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    retry: 1,
  })
}

/**
 * Mutation: self-assign the GitHub PR to the current user (guarded).
 */
export function useAssignPrToMe(projectId: string | null) {
  return useMutation({
    mutationFn: async (vars: { prNumber: number }): Promise<StepResult> => {
      return invoke<StepResult>('assign_pr_to_me', {
        projectId: projectId ?? undefined,
        prNumber: vars.prNumber,
      })
    },
  })
}

/**
 * Mutation: resume a pipeline PR — create a worktree and self-assign on both the
 * GitHub PR and the linked ClickUp task. Refreshes worktree/clickup caches.
 */
export function useResumeAiPipelinePr(projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { prNumber: number }): Promise<ResumeResult> => {
      return invoke<ResumeResult>('resume_ai_pipeline_pr', {
        projectId: projectId ?? undefined,
        prNumber: vars.prNumber,
      })
    },
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })
      }
      queryClient.invalidateQueries({ queryKey: ['clickup'] })
    },
  })
}

/**
 * Mutation: finish a pipeline PR — ClickUp status → `to deploy` + merge the PR.
 */
export function useFinishAiPipelinePr(projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: {
      worktreePath: string
      taskId?: string
    }): Promise<FinishResult> => {
      return invoke<FinishResult>('finish_ai_pipeline_pr', {
        worktreePath: vars.worktreePath,
        projectId: projectId ?? undefined,
        taskId: vars.taskId,
      })
    },
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })
      }
      queryClient.invalidateQueries({ queryKey: ['clickup'] })
    },
  })
}

/**
 * Mutation: save the AI pipeline config (dashboard URL + label).
 */
export function useSaveAiPipelineConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: {
      dashboardUrl?: string
      pipelineLabel?: string
    }) => {
      await invoke('set_ai_pipeline_config', {
        dashboardUrl: vars.dashboardUrl,
        pipelineLabel: vars.pipelineLabel,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: aiPipelineQueryKeys.all })
    },
  })
}
