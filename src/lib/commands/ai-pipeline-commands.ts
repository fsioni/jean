import { Bot } from 'lucide-react'
import type { AppCommand } from './types'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'

/**
 * Command-palette entry (Cmd/Ctrl+K) for the AI pipeline lifecycle. Opens the
 * dedicated modal; the list itself is scoped to the **pinned** project (falling
 * back to the selected one), so it works from anywhere. Isolated perso file so
 * merge-forwards stay cheap.
 */
export const aiPipelineCommands: AppCommand[] = [
  {
    id: 'open-ai-pipeline-prs',
    label: 'Pipeline IA',
    description: 'Reprendre un ticket (review ou bloqué) / terminer une PR',
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
      'stuck',
      'bloqué',
    ],

    execute: () => {
      // The modal resolves the pinned project itself; the selected one is only
      // a fallback, so the entry stays usable outside a project context.
      const { selectedProjectId } = useProjectsStore.getState()
      useUIStore
        .getState()
        .setAiPipelineModalOpen(true, selectedProjectId ?? undefined)
    },
  },
]
