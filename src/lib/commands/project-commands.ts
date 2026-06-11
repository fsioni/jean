import {
  FolderPlus,
  Bug,
  Keyboard,
  Archive,
  ArchiveRestore,
  Settings,
  RefreshCw,
  BellDot,
} from 'lucide-react'
import type { AppCommand } from './types'
import { useUIStore } from '@/store/ui-store'

export const projectCommands: AppCommand[] = [
  {
    id: 'add-project',
    label: 'Add Project',
    description: 'Add an existing git repository as a project',
    icon: FolderPlus,
    group: 'projects',
    keywords: ['project', 'add', 'import', 'repository', 'git'],

    isAvailable: context => context.hasInstalledBackend(),

    execute: context => {
      context.addProject()
    },
  },

  {
    id: 'project-settings',
    label: 'Project Settings',
    description: 'Configure settings for the current project',
    icon: Settings,
    group: 'projects',
    keywords: [
      'project',
      'settings',
      'configure',
      'mcp',
      'branch',
      'jean.json',
    ],

    isAvailable: context => context.hasSelectedProject(),

    execute: context => {
      context.openProjectSettings()
    },
  },

  {
    id: 'toggle-debug-mode',
    label: 'Copy Debug Details',
    description: 'Copy current session debug details to clipboard',
    icon: Bug,
    group: 'settings',
    keywords: ['debug', 'developer', 'dev', 'details', 'clipboard', 'copy'],
    isAvailable: context =>
      context.hasActiveSession() || context.hasActiveWorktree(),

    execute: async context => {
      await context.copySessionDebugDetails()
    },
  },

  {
    id: 'help.feature-tour',
    label: 'Show Onboarding Tour',
    description: 'Replay the Magic Menu and productivity tour',
    icon: Keyboard,
    group: 'help',
    keywords: [
      'tour',
      'boarding',
      'onboarding',
      'magic',
      'menu',
      'automation',
      'mr',
      'robot',
      'shortcuts',
      'keybindings',
      'help',
      'keyboard',
    ],

    execute: () => {
      useUIStore.setState({
        featureTourOpen: true,
        onboardingOpen: false,
        onboardingManuallyTriggered: false,
      })
    },
  },

  {
    id: 'open-archive',
    label: 'Open Archive',
    description: 'View archived worktrees and sessions',
    icon: Archive,
    group: 'projects',
    keywords: ['archive', 'archived', 'trash', 'deleted', 'removed'],

    execute: context => {
      context.openArchivedModal()
    },
  },

  {
    id: 'restore-last-archived',
    label: 'Restore Last Archived',
    description: 'Restore the most recently archived item',
    icon: ArchiveRestore,
    group: 'projects',
    keywords: ['archive', 'restore', 'undo', 'unarchive', 'recover'],

    execute: context => {
      context.restoreLastArchived()
    },
  },

  {
    id: 'unread-sessions',
    label: 'Unread Sessions',
    description: 'View sessions with new activity since last opened',
    icon: BellDot,
    group: 'sessions',
    keywords: [
      'unread',
      'new',
      'activity',
      'sessions',
      'inbox',
      'notifications',
    ],

    execute: context => {
      context.openUnreadSessions()
    },
  },

  {
    id: 'regenerate-session-title',
    label: 'Regenerate Session Title',
    description: 'Use AI to generate a new title for the current session',
    icon: RefreshCw,
    group: 'sessions',
    keywords: ['session', 'title', 'name', 'regenerate', 'rename', 'ai'],

    execute: context => {
      context.regenerateSessionName()
    },
  },
]
