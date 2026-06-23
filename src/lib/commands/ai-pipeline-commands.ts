import { Bot } from 'lucide-react'
import type { AppCommand } from './types'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'

/**
 * Command-palette entry (Cmd/Ctrl+K) for the AI pipeline PR lifecycle. Opens the
 * dedicated modal scoped to the selected project. Isolated perso file so
 * merge-forwards stay cheap.
 */
export const aiPipelineCommands: AppCommand[] = [
  {
    id: 'open-ai-pipeline-prs',
    label: 'PR pipeline IA',
    description: 'Reprendre / terminer une PR de la pipeline IA',
    icon: Bot,
    group: 'github',
    keywords: [
      'ai',
      'pipeline',
      'ia',
      'pr',
      'reprendre',
      'resume',
      'clickup',
      'deploy',
      'full-flow',
    ],

    execute: () => {
      const { selectedProjectId } = useProjectsStore.getState()
      if (!selectedProjectId) return
      useUIStore.getState().setAiPipelineModalOpen(true, selectedProjectId)
    },
    isAvailable: context => context.hasSelectedProject(),
  },
]
