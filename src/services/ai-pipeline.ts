import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import type {
  AiPipelineConfig,
  AiPipelinePr,
  AiPipelineTaskLists,
  FinishResult,
  ResumeResult,
  StepResult,
} from '@/types/ai-pipeline'
import { isTauri, projectsQueryKeys, useProjects } from './projects'
import { useProjectsStore } from '@/store/projects-store'
import { useClickUpConfig } from './clickup'

function hasValue(value: string | null | undefined): boolean {
  return !!value?.trim()
}

// Query keys for the AI pipeline.
export const aiPipelineQueryKeys = {
  all: ['ai-pipeline'] as const,
  config: () => [...aiPipelineQueryKeys.all, 'config'] as const,
  prs: (projectId: string) =>
    [...aiPipelineQueryKeys.all, 'prs', projectId] as const,
  tasks: (projectId: string) =>
    [...aiPipelineQueryKeys.all, 'tasks', projectId] as const,
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
 * Whether the AI pipeline feature is usable. It joins ClickUp review tickets
 * with GitHub PRs (via `gh`), so it's gated on ClickUp being configured — PR
 * data needs no extra credential beyond Jean's existing `gh` auth.
 */
export function useHasAiPipelineAccess(): boolean {
  const { data: clickup } = useClickUpConfig()
  return hasValue(clickup?.token)
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

const EMPTY_TASK_LISTS: AiPipelineTaskLists = { review: [], stuck: [] }

/**
 * List the pickable ClickUp tickets for a project, in two buckets: the review
 * columns (PR ready) and the `stuck` column (PR optional). ClickUp is the
 * source of truth.
 */
export function useAiPipelineTasks(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const hasAccess = useHasAiPipelineAccess()
  const enabled = (options?.enabled ?? true) && !!projectId && hasAccess

  return useQuery({
    queryKey: aiPipelineQueryKeys.tasks(projectId ?? ''),
    queryFn: async (): Promise<AiPipelineTaskLists> => {
      if (!isTauri() || !projectId) return EMPTY_TASK_LISTS
      return invoke<AiPipelineTaskLists>('list_ai_pipeline_tasks', {
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
 * The project the pipeline lists are scoped to: the pinned one when it still
 * exists, else the caller's context (the project the modal was opened from),
 * else the selected project. Keeps the lists stable whatever the entry point.
 */
export function useAiPipelineProjectId(contextProjectId?: string | null) {
  const { data: config } = useAiPipelineConfig()
  const { data: projects } = useProjects()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)

  const pinnedId = config?.projectId
  const pinnedExists = !!pinnedId && !!projects?.some(p => p.id === pinnedId)
  const projectId =
    (pinnedExists ? pinnedId : null) ??
    contextProjectId ??
    selectedProjectId ??
    null

  return {
    projectId,
    /** `true` when the project comes from the persisted pin, not the context. */
    isPinned: pinnedExists && pinnedId === projectId,
    project: projects?.find(p => p.id === projectId) ?? null,
  }
}

/**
 * Mutation: pin (or unpin with `null`) the project the pipeline lists use.
 */
export function useSetAiPipelineProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (projectId: string | null) => {
      await invoke('set_ai_pipeline_project', {
        projectId: projectId ?? undefined,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: aiPipelineQueryKeys.config() })
    },
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
 * Mutation: resume a pipeline ticket — create a worktree (from its PR when it
 * has one, else on a fresh `CU-<id>` branch), self-assign the PR, and claim the
 * ClickUp task (self-assign + status move). Refreshes worktree/clickup/pipeline
 * caches so a resumed ticket leaves the list without closing it.
 */
export function useResumeAiPipelineTask(projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: {
      taskId: string
      prNumber?: number
      targetStatus?: string
    }): Promise<ResumeResult> => {
      return invoke<ResumeResult>('resume_ai_pipeline_task', {
        projectId: projectId ?? undefined,
        taskId: vars.taskId,
        prNumber: vars.prNumber,
        targetStatus: vars.targetStatus,
      })
    },
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })
        queryClient.invalidateQueries({
          queryKey: aiPipelineQueryKeys.tasks(projectId),
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
 * Mutation: save the AI pipeline config (pipeline label).
 */
export function useSaveAiPipelineConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { pipelineLabel?: string }) => {
      await invoke('set_ai_pipeline_config', {
        pipelineLabel: vars.pipelineLabel,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: aiPipelineQueryKeys.all })
    },
  })
}
