import { useCallback } from 'react'
import { toast } from 'sonner'
import { Pin, PinOff } from 'lucide-react'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useProjects } from '@/services/projects'
import { useSetAiPipelineProject } from '@/services/ai-pipeline'

/**
 * Project the pipeline lists are scoped to. Picking one **pins** it in the
 * sidecar config, so the same tickets show up from every entry point (sidebar,
 * New Session tab, command palette) — not just from the project you happened to
 * open the modal from.
 */
export function AiPipelineProjectPicker({
  projectId,
  isPinned,
}: {
  projectId: string | null
  isPinned: boolean
}) {
  const { data: projects } = useProjects()
  const setProject = useSetAiPipelineProject()

  const handleChange = useCallback(
    (value: string) => {
      setProject.mutate(value || null, {
        onSuccess: () =>
          toast.success(
            value
              ? 'Projet de la pipeline IA épinglé'
              : 'Projet de la pipeline IA désépinglé'
          ),
        onError: e => toast.error(`Échec : ${e}`),
      })
    },
    [setProject]
  )

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground">
            {isPinned ? (
              <Pin className="size-3.5" />
            ) : (
              <PinOff className="size-3.5" />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isPinned
            ? 'Projet épinglé : les mêmes tickets, quel que soit le point d’entrée'
            : 'Aucun projet épinglé : la liste suit le projet courant'}
        </TooltipContent>
      </Tooltip>
      <NativeSelect
        aria-label="Projet de la pipeline IA"
        className="h-7 w-auto py-0 text-xs"
        value={projectId ?? ''}
        disabled={setProject.isPending}
        onChange={e => handleChange(e.target.value)}
      >
        <NativeSelectOption value="">
          Projet courant (non épinglé)
        </NativeSelectOption>
        {(projects ?? []).map(project => (
          <NativeSelectOption key={project.id} value={project.id}>
            {project.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}

export default AiPipelineProjectPicker
