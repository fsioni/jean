import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type FC,
} from 'react'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, ChevronDown, Check, ChevronsUpDown, Play } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { BackendLabel } from '@/components/ui/backend-label'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  useClaudeCliStatus,
  useClaudeCliAuth,
  useAvailableCliVersions,
  claudeCliQueryKeys,
  useClaudePathDetection,
} from '@/services/claude-cli'
import {
  useGhCliStatus,
  useGhCliAuth,
  useGhPathDetection,
  useAvailableGhVersions,
  ghCliQueryKeys,
} from '@/services/gh-cli'
import {
  useCodexCliStatus,
  useCodexCliAuth,
  useAvailableCodexVersions,
  codexCliQueryKeys,
  useCodexPathDetection,
} from '@/services/codex-cli'
import {
  useOpenCodeCliStatus,
  useOpenCodeCliAuth,
  useAvailableOpencodeModels,
  useAvailableOpencodeVersions,
  opencodeCliQueryKeys,
  useOpenCodePathDetection,
} from '@/services/opencode-cli'
import { useUIStore } from '@/store/ui-store'
import {
  getCursorInstallCommand,
  useCursorCliStatus,
  useCursorCliAuth,
  useCursorPathDetection,
  useAvailableCursorModels,
  cursorCliQueryKeys,
} from '@/services/cursor-cli'
import type { ClaudeAuthStatus } from '@/types/claude-cli'
import type { GhAuthStatus } from '@/types/gh-cli'
import type { CodexAuthStatus } from '@/types/codex-cli'
import type { OpenCodeAuthStatus } from '@/types/opencode-cli'
import type { CursorAuthStatus } from '@/types/cursor-cli'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import {
  modelOptions,
  thinkingLevelOptions,
  effortLevelOptions,
  codexDefaultModelOptions,
  codexReasoningOptions,
  backendOptions,
  terminalOptions,
  editorOptions,
  gitPollIntervalOptions,
  remotePollIntervalOptions,
  archiveRetentionOptions,
  removalBehaviorOptions,
  notificationSoundOptions,
  type RemovalBehavior,
  type ClaudeModel,
  type CodexModel,
  type CodexReasoningEffort,
  type CursorModel,
  type CliBackend,
  type TerminalApp,
  type EditorApp,
  type NotificationSound,
  openInDefaultOptions,
  type OpenInDefault,
} from '@/types/preferences'
import {
  CURSOR_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import {
  formatCursorModelLabel,
  formatOpencodeModelLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import { playNotificationSound } from '@/lib/sounds'
import type { ThinkingLevel, EffortLevel } from '@/types/chat'
import { hasBackend, isNativeApp } from '@/lib/environment'
import { isNewerVersion } from '@/lib/version-utils'
import { cn } from '@/lib/utils'
import { copyToClipboard } from '@/lib/clipboard'
import {
  setGitPollInterval,
  setRemotePollInterval,
} from '@/services/git-status'
import { getPathUpdateAction } from '@/lib/cli-update'
import { SettingsSection } from '../SettingsSection'

interface CleanupResult {
  deleted_worktrees: number
  deleted_sessions: number
}

const InlineField: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-96 sm:shrink-0">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground break-words">
          {description}
        </div>
      )}
    </div>
    {children}
  </div>
)

export const GeneralPane: React.FC = () => {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteCliTarget, setDeleteCliTarget] = useState<
    'claude' | 'codex' | 'opencode' | 'gh' | null
  >(null)
  const [isDeletingCli, setIsDeletingCli] = useState(false)

  // PATH detection
  const { data: pathDetection } = useClaudePathDetection()
  const { data: codexPathDetection } = useCodexPathDetection()
  const { data: opencodePathDetection } = useOpenCodePathDetection()
  const { data: ghPathDetection } = useGhPathDetection()
  const { data: cursorPathDetection } = useCursorPathDetection()

  // CLI status hooks
  const { data: cliStatus, isLoading: isCliLoading } = useClaudeCliStatus()
  const isPathSource = preferences?.claude_cli_source === 'path'
  const { data: claudeVersions, isLoading: isClaudeVersionsLoading } =
    useAvailableCliVersions({ enabled: isPathSource && !!cliStatus?.installed })
  const claudeLatestStable = claudeVersions?.find(v => !v.prerelease)
  const claudeHasUpdate =
    !!cliStatus?.version &&
    !!claudeLatestStable &&
    isNewerVersion(claudeLatestStable.version, cliStatus.version)
  const { data: ghStatus, isLoading: isGhLoading } = useGhCliStatus()
  const { data: cursorStatus, isLoading: isCursorLoading } =
    useCursorCliStatus()
  const isGhPathSource = preferences?.gh_cli_source === 'path'
  const { data: ghVersions, isLoading: isGhVersionsLoading } =
    useAvailableGhVersions({ enabled: isGhPathSource && !!ghStatus?.installed })
  const ghLatestStable = ghVersions?.find(v => !v.prerelease)
  const ghHasUpdate =
    !!ghStatus?.version &&
    !!ghLatestStable &&
    isNewerVersion(ghLatestStable.version, ghStatus.version)
  const { data: codexStatus, isLoading: isCodexLoading } = useCodexCliStatus()
  const isCodexPathSource = preferences?.codex_cli_source === 'path'
  const { data: codexVersions, isLoading: isCodexVersionsLoading } =
    useAvailableCodexVersions({
      enabled: isCodexPathSource && !!codexStatus?.installed,
    })
  const codexLatestStable = codexVersions?.find(v => !v.prerelease)
  const codexHasUpdate =
    !!codexStatus?.version &&
    !!codexLatestStable &&
    isNewerVersion(codexLatestStable.version, codexStatus.version)
  const { data: opencodeStatus, isLoading: isOpenCodeLoading } =
    useOpenCodeCliStatus()
  const isOpencodePathSource = preferences?.opencode_cli_source === 'path'
  const { data: opencodeVersions, isLoading: isOpencodeVersionsLoading } =
    useAvailableOpencodeVersions({
      enabled: isOpencodePathSource && !!opencodeStatus?.installed,
    })
  const opencodeLatestStable = opencodeVersions?.find(v => !v.prerelease)
  const opencodeHasUpdate =
    !!opencodeStatus?.version &&
    !!opencodeLatestStable &&
    isNewerVersion(opencodeLatestStable.version, opencodeStatus.version)

  // Auth status queries - only enabled when CLI is installed
  const { data: claudeAuth, isLoading: isClaudeAuthLoading } = useClaudeCliAuth(
    {
      enabled: !!cliStatus?.installed,
    }
  )
  const { data: ghAuth, isLoading: isGhAuthLoading } = useGhCliAuth({
    enabled: !!ghStatus?.installed,
  })
  const { data: codexAuth, isLoading: isCodexAuthLoading } = useCodexCliAuth({
    enabled: !!codexStatus?.installed,
  })
  const { data: opencodeAuth, isLoading: isOpenCodeAuthLoading } =
    useOpenCodeCliAuth({
      enabled: !!opencodeStatus?.installed,
    })
  const { data: cursorAuth, isLoading: isCursorAuthLoading } = useCursorCliAuth(
    {
      enabled: !!cursorStatus?.installed,
    }
  )
  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: !!opencodeStatus?.installed,
  })
  const { data: availableCursorModels } = useAvailableCursorModels({
    enabled: !!cursorStatus?.installed,
  })

  // Re-check CLI status when the source preference changes (handles initial load
  // with source already set to "path" and any timing issues with onSuccess invalidation)
  const prevSources = useRef({
    claude: preferences?.claude_cli_source,
    gh: preferences?.gh_cli_source,
    codex: preferences?.codex_cli_source,
    opencode: preferences?.opencode_cli_source,
  })
  useEffect(() => {
    const cur = {
      claude: preferences?.claude_cli_source,
      gh: preferences?.gh_cli_source,
      codex: preferences?.codex_cli_source,
      opencode: preferences?.opencode_cli_source,
    }
    if (cur.claude !== prevSources.current.claude) {
      queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.status() })
    }
    if (cur.gh !== prevSources.current.gh) {
      queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.status() })
    }
    if (cur.codex !== prevSources.current.codex) {
      queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.status() })
    }
    if (cur.opencode !== prevSources.current.opencode) {
      queryClient.invalidateQueries({ queryKey: opencodeCliQueryKeys.status() })
    }
    prevSources.current = cur
  }, [
    preferences?.claude_cli_source,
    preferences?.gh_cli_source,
    preferences?.codex_cli_source,
    preferences?.opencode_cli_source,
    queryClient,
  ])

  useEffect(() => {
    if (!preferences?.build_backend) return
    const backend = preferences.build_backend
    if (backend === 'cursor' && !cursorStatus?.installed) {
      patchPreferences.mutate({
        build_backend: null,
        build_model: null,
        build_thinking_level: null,
      })
    }
  }, [patchPreferences, preferences?.build_backend, cursorStatus?.installed])

  // Track which auth check is in progress (for manual refresh)
  const [checkingClaudeAuth, setCheckingClaudeAuth] = useState(false)
  const [checkingGhAuth, setCheckingGhAuth] = useState(false)
  const [checkingCodexAuth, setCheckingCodexAuth] = useState(false)
  const [checkingOpenCodeAuth, setCheckingOpenCodeAuth] = useState(false)
  const [checkingCursorAuth, setCheckingCursorAuth] = useState(false)
  const [openCodeModelPopoverOpen, setOpenCodeModelPopoverOpen] =
    useState(false)
  const [cursorModelPopoverOpen, setCursorModelPopoverOpen] = useState(false)
  const [buildModelPopoverOpen, setBuildModelPopoverOpen] = useState(false)
  const [yoloModelPopoverOpen, setYoloModelPopoverOpen] = useState(false)

  // Use global ui-store for CLI modals
  const openCliUpdateModal = useUIStore(state => state.openCliUpdateModal)
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)

  const handleDeleteAllArchives = useCallback(async () => {
    setIsDeleting(true)
    const toastId = toast.loading('Deleting all archives...')

    try {
      const result = await invoke<CleanupResult>('delete_all_archives')

      // Invalidate archive queries to refresh UI
      queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })
      queryClient.invalidateQueries({ queryKey: ['all-archived-sessions'] })

      const parts: string[] = []
      if (result.deleted_worktrees > 0) {
        parts.push(
          `${result.deleted_worktrees} worktree${result.deleted_worktrees === 1 ? '' : 's'}`
        )
      }
      if (result.deleted_sessions > 0) {
        parts.push(
          `${result.deleted_sessions} session${result.deleted_sessions === 1 ? '' : 's'}`
        )
      }

      if (parts.length > 0) {
        toast.success(`Deleted ${parts.join(' and ')}`, { id: toastId })
      } else {
        toast.info('No archives to delete', { id: toastId })
      }
    } catch (error) {
      toast.error(`Failed to delete archives: ${error}`, { id: toastId })
    } finally {
      setIsDeleting(false)
      setShowDeleteAllDialog(false)
    }
  }, [queryClient])

  const handleModelChange = (value: ClaudeModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_model: value })
    }
  }

  const handleThinkingLevelChange = (value: ThinkingLevel) => {
    if (preferences) {
      patchPreferences.mutate({ thinking_level: value })
    }
  }

  const handleEffortLevelChange = (value: EffortLevel) => {
    if (preferences) {
      patchPreferences.mutate({ default_effort_level: value })
    }
  }

  const handleBuildModelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        build_model: value === 'default' ? null : value,
      })
    }
  }

  const handleBuildBackendChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        build_backend: value === 'default' ? null : value,
        // Reset model and thinking/effort when backend changes
        build_model: null,
        build_thinking_level: null,
        build_effort_level: null,
      })
    }
  }

  const handleYoloModelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        yolo_model: value === 'default' ? null : value,
      })
    }
  }

  const handleYoloBackendChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        yolo_backend: value === 'default' ? null : value,
        // Reset model and thinking/effort when backend changes
        yolo_model: null,
        yolo_thinking_level: null,
        yolo_effort_level: null,
      })
    }
  }

  const handleBuildThinkingLevelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        build_thinking_level: value === 'default' ? null : value,
      })
    }
  }

  const handleYoloThinkingLevelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        yolo_thinking_level: value === 'default' ? null : value,
      })
    }
  }

  const handleBuildEffortLevelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        build_effort_level: value === 'default' ? null : value,
      })
    }
  }

  const handleYoloEffortLevelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        yolo_effort_level: value === 'default' ? null : value,
      })
    }
  }

  const handleClaudeSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { claude_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleCodexSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { codex_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleOpencodeSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { opencode_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({
              queryKey: opencodeCliQueryKeys.all,
            })
          },
        }
      )
    }
  }

  const handleConfirmDeleteCli = async () => {
    if (!deleteCliTarget) return
    const target = deleteCliTarget
    const labelMap = {
      claude: { name: 'Claude CLI', cmd: 'uninstall_claude_cli' as const },
      codex: { name: 'Codex CLI', cmd: 'uninstall_codex_cli' as const },
      opencode: {
        name: 'OpenCode CLI',
        cmd: 'uninstall_opencode_cli' as const,
      },
      gh: { name: 'GitHub CLI', cmd: 'uninstall_gh_cli' as const },
    }
    const { name, cmd } = labelMap[target]
    setIsDeletingCli(true)
    const toastId = toast.loading(`Removing Jean-managed ${name}...`)
    try {
      await invoke(cmd)
      const sourceKey =
        target === 'claude'
          ? 'claude_cli_source'
          : target === 'codex'
            ? 'codex_cli_source'
            : target === 'opencode'
              ? 'opencode_cli_source'
              : 'gh_cli_source'
      await new Promise<void>((resolve, reject) => {
        patchPreferences.mutate(
          { [sourceKey]: 'path' } as Partial<AppPreferences>,
          {
            onSuccess: () => resolve(),
            onError: err => reject(err),
          }
        )
      })
      const queryKeys =
        target === 'claude'
          ? claudeCliQueryKeys.all
          : target === 'codex'
            ? codexCliQueryKeys.all
            : target === 'opencode'
              ? opencodeCliQueryKeys.all
              : ghCliQueryKeys.all
      queryClient.invalidateQueries({ queryKey: queryKeys })
      const pathFound =
        target === 'claude'
          ? pathDetection?.found
          : target === 'codex'
            ? codexPathDetection?.found
            : target === 'opencode'
              ? opencodePathDetection?.found
              : ghPathDetection?.found
      if (pathFound) {
        toast.success(`Jean-managed ${name} removed. Using system PATH.`, {
          id: toastId,
        })
      } else {
        toast.warning(
          `Jean-managed ${name} removed. No system PATH version found — ${name} unavailable until reinstalled.`,
          { id: toastId }
        )
      }
    } catch (err) {
      toast.error(`Failed to remove ${name}: ${err}`, { id: toastId })
    } finally {
      setIsDeletingCli(false)
      setDeleteCliTarget(null)
    }
  }

  const handleGhSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { gh_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleBackendChange = (value: CliBackend) => {
    if (preferences) {
      patchPreferences.mutate({ default_backend: value })
    }
  }

  // If stored default_backend isn't installed, fall back to the first installed one
  const stored = preferences?.default_backend ?? 'claude'
  const claudeInstalled = cliStatus?.installed
  const codexInstalled = codexStatus?.installed
  const opencodeInstalled = opencodeStatus?.installed
  const cursorInstalled = cursorStatus?.installed
  const effectiveBackend = useMemo(() => {
    const installed: Record<string, boolean | undefined> = {
      claude: claudeInstalled,
      codex: codexInstalled,
      opencode: opencodeInstalled,
      cursor: cursorInstalled,
    }
    if (installed[stored]) return stored
    const first = backendOptions.find(o => installed[o.value])
    return first?.value ?? stored
  }, [
    stored,
    claudeInstalled,
    codexInstalled,
    opencodeInstalled,
    cursorInstalled,
  ])

  const handleCodexModelChange = (value: CodexModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_codex_model: value })
    }
  }

  const handleCodexReasoningChange = (value: CodexReasoningEffort) => {
    if (preferences) {
      patchPreferences.mutate({
        default_codex_reasoning_effort: value,
      })
    }
  }

  const handleOpenCodeModelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({ selected_opencode_model: value })
    }
  }

  const handleCursorModelChange = (value: CursorModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_cursor_model: value })
    }
  }

  const selectedOpenCodeModel =
    preferences?.selected_opencode_model ?? 'opencode/gpt-5'
  const formatOpenCodeModelLabelForSettings = (value: string) => {
    const formatted = formatOpencodeModelLabel(value)
    return value.startsWith('opencode/')
      ? formatted.replace(/\s+\(OpenCode\)$/, '')
      : formatted
  }
  const openCodeModelOptions = (
    availableOpencodeModels?.length
      ? availableOpencodeModels
      : OPENCODE_MODEL_OPTIONS.map(option => option.value)
  ).map(value => ({
    value,
    label: formatOpenCodeModelLabelForSettings(value),
  }))
  const selectedOpenCodeModelLabel =
    openCodeModelOptions.find(option => option.value === selectedOpenCodeModel)
      ?.label ?? formatOpenCodeModelLabelForSettings(selectedOpenCodeModel)
  const selectedCursorModel =
    preferences?.selected_cursor_model ?? 'cursor/auto'
  const cursorModelOptions: { value: CursorModel; label: string }[] = (
    availableCursorModels?.length
      ? availableCursorModels.map(model => ({
          value: `cursor/${model.id}` as CursorModel,
          label: model.label || formatCursorModelLabel(model.id),
        }))
      : (CURSOR_MODEL_OPTIONS as { value: CursorModel; label: string }[])
  ).map(option => ({
    value: option.value,
    label: option.label || formatCursorModelLabel(option.value),
  }))
  const selectedCursorModelLabel =
    cursorModelOptions.find(option => option.value === selectedCursorModel)
      ?.label ?? formatCursorModelLabel(selectedCursorModel)
  const buildBackendOptions = backendOptions
  const effectiveBuildBackend = (preferences?.build_backend ??
    effectiveBackend) as CliBackend
  const effectiveYoloBackend = (preferences?.yolo_backend ??
    effectiveBackend) as CliBackend
  const cursorAuthMessage = cursorAuth?.timed_out
    ? 'Auth check timed out. Try again or run login manually.'
    : cursorAuth?.error

  const handleCodexMultiAgentToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        codex_multi_agent_enabled: enabled,
      })
    }
  }

  const handleCodexMaxThreadsChange = (value: string) => {
    if (preferences) {
      const num = Math.max(1, Math.min(8, parseInt(value, 10) || 3))
      patchPreferences.mutate({
        codex_max_agent_threads: num,
      })
    }
  }

  const handleTerminalChange = (value: TerminalApp) => {
    if (preferences) {
      patchPreferences.mutate({ terminal: value })
    }
  }

  const handleEditorChange = (value: EditorApp) => {
    if (preferences) {
      patchPreferences.mutate({ editor: value })
    }
  }

  const handleOpenInChange = (value: OpenInDefault) => {
    if (preferences) {
      patchPreferences.mutate({ open_in: value })
    }
  }

  const handleAutoBranchNamingChange = (checked: boolean) => {
    if (preferences) {
      patchPreferences.mutate({ auto_branch_naming: checked })
    }
  }

  const handleAutoSessionNamingChange = (checked: boolean) => {
    if (preferences) {
      patchPreferences.mutate({ auto_session_naming: checked })
    }
  }

  const handleGitPollIntervalChange = (value: string) => {
    const seconds = parseInt(value, 10)
    if (preferences && !isNaN(seconds)) {
      patchPreferences.mutate({ git_poll_interval: seconds })
      // Also update the backend immediately
      setGitPollInterval(seconds)
    }
  }

  const handleRemotePollIntervalChange = (value: string) => {
    const seconds = parseInt(value, 10)
    if (preferences && !isNaN(seconds)) {
      patchPreferences.mutate({ remote_poll_interval: seconds })
      // Also update the backend immediately
      setRemotePollInterval(seconds)
    }
  }

  const handleArchiveRetentionChange = (value: string) => {
    const days = parseInt(value, 10)
    if (preferences && !isNaN(days)) {
      patchPreferences.mutate({ archive_retention_days: days })
    }
  }

  const handleWaitingSoundChange = (value: NotificationSound) => {
    if (preferences) {
      patchPreferences.mutate({ waiting_sound: value })
      // Play preview of the selected sound
      playNotificationSound(value)
    }
  }

  const handleReviewSoundChange = (value: NotificationSound) => {
    if (preferences) {
      patchPreferences.mutate({ review_sound: value })
      // Play preview of the selected sound
      playNotificationSound(value)
    }
  }

  const handleClaudeLogin = useCallback(async () => {
    if (!cliStatus?.path) return

    // First check if already authenticated
    setCheckingClaudeAuth(true)
    try {
      // Invalidate cache and refetch to get fresh status
      await queryClient.invalidateQueries({
        queryKey: claudeCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<ClaudeAuthStatus>({
        queryKey: claudeCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('Claude CLI is already authenticated')
        return
      }
    } finally {
      setCheckingClaudeAuth(false)
    }

    // Not authenticated, open login modal
    const args = cliStatus.supports_auth_command ? ['auth', 'login'] : ['login']
    openCliLoginModal('claude', cliStatus.path, args)
  }, [
    cliStatus?.path,
    cliStatus?.supports_auth_command,
    openCliLoginModal,
    queryClient,
  ])

  const handleGhLogin = useCallback(async () => {
    if (!ghStatus?.path) return

    // First check if already authenticated
    setCheckingGhAuth(true)
    try {
      // Invalidate cache and refetch to get fresh status
      await queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.auth() })
      const result = await queryClient.fetchQuery<GhAuthStatus>({
        queryKey: ghCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('GitHub CLI is already authenticated')
        return
      }
    } finally {
      setCheckingGhAuth(false)
    }

    // Not authenticated, open login modal
    openCliLoginModal('gh', ghStatus.path, ['auth', 'login'])
  }, [ghStatus?.path, openCliLoginModal, queryClient])

  const handleCodexLogin = useCallback(async () => {
    if (!codexStatus?.path) return

    setCheckingCodexAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: codexCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<CodexAuthStatus>({
        queryKey: codexCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('Codex CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCodexAuth(false)
    }

    // Not authenticated, open login modal
    openCliLoginModal('codex', codexStatus.path, ['login'])
  }, [codexStatus?.path, openCliLoginModal, queryClient])

  const handleOpenCodeLogin = useCallback(async () => {
    if (!opencodeStatus?.path) return

    setCheckingOpenCodeAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: opencodeCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<OpenCodeAuthStatus>({
        queryKey: opencodeCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('OpenCode CLI is already authenticated')
        return
      }
    } finally {
      setCheckingOpenCodeAuth(false)
    }

    openCliLoginModal('opencode', opencodeStatus.path, ['auth', 'login'])
  }, [opencodeStatus?.path, openCliLoginModal, queryClient])

  const handleClaudeRelogin = useCallback(() => {
    if (!cliStatus?.path) return
    const args = cliStatus.supports_auth_command ? ['auth', 'login'] : ['login']
    openCliLoginModal('claude', cliStatus.path, args)
  }, [cliStatus?.path, cliStatus?.supports_auth_command, openCliLoginModal])

  const handleGhRelogin = useCallback(() => {
    if (!ghStatus?.path) return
    openCliLoginModal('gh', ghStatus.path, ['auth', 'login'])
  }, [ghStatus?.path, openCliLoginModal])

  const handleCodexRelogin = useCallback(() => {
    if (!codexStatus?.path) return
    openCliLoginModal('codex', codexStatus.path, ['login'])
  }, [codexStatus?.path, openCliLoginModal])

  const handleOpenCodeRelogin = useCallback(() => {
    if (!opencodeStatus?.path) return
    openCliLoginModal('opencode', opencodeStatus.path, ['auth', 'login'])
  }, [opencodeStatus?.path, openCliLoginModal])

  const handleCursorLogin = useCallback(async () => {
    if (!cursorStatus?.path) return

    setCheckingCursorAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: cursorCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<CursorAuthStatus>({
        queryKey: cursorCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('Cursor CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCursorAuth(false)
    }

    openCliLoginModal('cursor', cursorStatus.path, ['login'])
  }, [cursorStatus?.path, openCliLoginModal, queryClient])

  const handleCursorRelogin = useCallback(() => {
    if (!cursorStatus?.path) return
    openCliLoginModal('cursor', cursorStatus.path, ['login'])
  }, [cursorStatus?.path, openCliLoginModal])

  const handleCursorUpdate = useCallback(() => {
    if (!cursorStatus?.path) return
    openCliLoginModal('cursor', cursorStatus.path, ['update'], 'update')
  }, [cursorStatus?.path, openCliLoginModal])

  const handleCursorInstall = useCallback(async () => {
    try {
      const installCommand = await getCursorInstallCommand()
      openCliLoginModal(
        'cursor',
        installCommand.command,
        installCommand.args,
        'install'
      )
    } catch (error) {
      toast.error('Failed to prepare Cursor Agent install command', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [openCliLoginModal])

  const handleCopyPath = useCallback((path: string | null | undefined) => {
    if (!path) return
    copyToClipboard(path)
    toast.success('Path copied to clipboard')
  }, [])

  return (
    <div className="space-y-6">
      {hasBackend() && (
        <SettingsSection
          title="Claude CLI"
          anchorId="pref-general-section-claude-cli"
          actions={
            cliStatus?.installed ? (
              checkingClaudeAuth || isClaudeAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : claudeAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClaudeRelogin}
                  >
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button variant="outline" size="sm" onClick={handleClaudeLogin}>
                  Login
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Not installed
              </span>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={cliStatus?.installed ? 'Version' : 'Status'}
              description={
                cliStatus?.installed
                  ? 'Enables Claude AI sessions'
                  : 'Optional — enables Claude AI sessions'
              }
            >
              {isCliLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : cliStatus?.installed ? (
                isPathSource ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {cliStatus.version ?? 'Installed'}
                    </span>
                    {isClaudeVersionsLoading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!claudeHasUpdate}
                        onClick={() => {
                          const action = getPathUpdateAction(
                            cliStatus.path,
                            pathDetection?.package_manager,
                            'claude-code',
                            ['update']
                          )
                          if (action) {
                            openCliLoginModal(
                              'claude',
                              action[0],
                              action[1],
                              'update'
                            )
                          } else {
                            openCliUpdateModal('claude')
                          }
                        }}
                      >
                        {claudeHasUpdate
                          ? `Update to ${claudeLatestStable?.version}`
                          : 'Up to date'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={() => openCliUpdateModal('claude')}
                  >
                    {cliStatus.version ?? 'Installed'}
                    <ChevronDown className="size-3" />
                  </Button>
                )
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={() => openCliUpdateModal('claude')}
                >
                  Install
                </Button>
              )}
            </InlineField>
            {(cliStatus?.installed || pathDetection?.found) && (
              <InlineField
                label="Source"
                description={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          handleCopyPath(
                            preferences?.claude_cli_source === 'path'
                              ? pathDetection?.path
                              : cliStatus?.path
                          )
                        }
                        className="text-left hover:underline cursor-pointer"
                      >
                        {preferences?.claude_cli_source === 'path'
                          ? (pathDetection?.path ?? 'System PATH')
                          : (cliStatus?.path ?? 'Not installed')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                }
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.claude_cli_source ?? 'jean'}
                    onValueChange={handleClaudeSourceChange}
                  >
                    <SelectTrigger className="w-96">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jean">Jean (managed)</SelectItem>
                      <SelectItem value="path" disabled={!pathDetection?.found}>
                        System PATH
                        {!pathDetection?.found && ' (not found)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {preferences?.claude_cli_source === 'jean' &&
                    cliStatus?.installed && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteCliTarget('claude')}
                      >
                        Delete managed install
                      </Button>
                    )}
                </div>
              </InlineField>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && (
        <SettingsSection
          title="GitHub CLI"
          anchorId="pref-general-section-github-cli"
          actions={
            ghStatus?.installed ? (
              checkingGhAuth || isGhAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : ghAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button variant="outline" size="sm" onClick={handleGhRelogin}>
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button variant="outline" size="sm" onClick={handleGhLogin}>
                  Login
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Not installed
              </span>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={ghStatus?.installed ? 'Version' : 'Status'}
              description={
                ghStatus?.installed
                  ? 'Enables GitHub integration'
                  : 'Optional — enables GitHub integration'
              }
            >
              {isGhLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : ghStatus?.installed ? (
                isGhPathSource ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {ghStatus.version ?? 'Installed'}
                    </span>
                    {isGhVersionsLoading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!ghHasUpdate}
                        onClick={() => {
                          const action = getPathUpdateAction(
                            ghStatus.path,
                            ghPathDetection?.package_manager,
                            'gh',
                            null
                          )
                          if (action) {
                            openCliLoginModal(
                              'gh',
                              action[0],
                              action[1],
                              'update'
                            )
                          } else {
                            openCliUpdateModal('gh')
                          }
                        }}
                      >
                        {ghHasUpdate
                          ? `Update to ${ghLatestStable?.version}`
                          : 'Up to date'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={() => openCliUpdateModal('gh')}
                  >
                    {ghStatus.version ?? 'Installed'}
                    <ChevronDown className="size-3" />
                  </Button>
                )
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={() => openCliUpdateModal('gh')}
                >
                  Install
                </Button>
              )}
            </InlineField>
            {(ghStatus?.installed || ghPathDetection?.found) && (
              <InlineField
                label="Source"
                description={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          handleCopyPath(
                            preferences?.gh_cli_source === 'path'
                              ? ghPathDetection?.path
                              : ghStatus?.path
                          )
                        }
                        className="text-left hover:underline cursor-pointer"
                      >
                        {preferences?.gh_cli_source === 'path'
                          ? (ghPathDetection?.path ?? 'System PATH')
                          : (ghStatus?.path ?? 'Not installed')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                }
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.gh_cli_source ?? 'jean'}
                    onValueChange={handleGhSourceChange}
                  >
                    <SelectTrigger className="w-96">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jean">Jean (managed)</SelectItem>
                      <SelectItem
                        value="path"
                        disabled={!ghPathDetection?.found}
                      >
                        System PATH
                        {!ghPathDetection?.found && ' (not found)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {preferences?.gh_cli_source === 'jean' &&
                    ghStatus?.installed && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteCliTarget('gh')}
                      >
                        Delete managed install
                      </Button>
                    )}
                </div>
              </InlineField>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && (
        <SettingsSection
          title="Codex CLI"
          anchorId="pref-general-section-codex-cli"
          actions={
            codexStatus?.installed ? (
              checkingCodexAuth || isCodexAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : codexAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCodexRelogin}
                  >
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button variant="outline" size="sm" onClick={handleCodexLogin}>
                  Login
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Not installed
              </span>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={codexStatus?.installed ? 'Version' : 'Status'}
              description={
                codexStatus?.installed
                  ? 'Enables Codex AI sessions'
                  : 'Optional — enables Codex AI sessions'
              }
            >
              {isCodexLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : codexStatus?.installed ? (
                isCodexPathSource ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {codexStatus.version ?? 'Installed'}
                    </span>
                    {isCodexVersionsLoading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!codexHasUpdate}
                        onClick={() => {
                          const action = getPathUpdateAction(
                            codexStatus.path,
                            codexPathDetection?.package_manager,
                            'codex',
                            null,
                            '@openai/codex',
                            codexLatestStable?.version
                          )
                          if (action) {
                            openCliLoginModal(
                              'codex',
                              action[0],
                              action[1],
                              'update'
                            )
                          } else {
                            openCliUpdateModal('codex')
                          }
                        }}
                      >
                        {codexHasUpdate
                          ? `Update to ${codexLatestStable?.version}`
                          : 'Up to date'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={() => openCliUpdateModal('codex')}
                  >
                    {codexStatus.version ?? 'Installed'}
                    <ChevronDown className="size-3" />
                  </Button>
                )
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={() => openCliUpdateModal('codex')}
                >
                  Install
                </Button>
              )}
            </InlineField>
            {(codexStatus?.installed || codexPathDetection?.found) && (
              <InlineField
                label="Source"
                description={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          handleCopyPath(
                            preferences?.codex_cli_source === 'path'
                              ? codexPathDetection?.path
                              : codexStatus?.path
                          )
                        }
                        className="text-left hover:underline cursor-pointer"
                      >
                        {preferences?.codex_cli_source === 'path'
                          ? (codexPathDetection?.path ?? 'System PATH')
                          : (codexStatus?.path ?? 'Not installed')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                }
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.codex_cli_source ?? 'jean'}
                    onValueChange={handleCodexSourceChange}
                  >
                    <SelectTrigger className="w-96">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jean">Jean (managed)</SelectItem>
                      <SelectItem
                        value="path"
                        disabled={!codexPathDetection?.found}
                      >
                        System PATH
                        {!codexPathDetection?.found && ' (not found)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {preferences?.codex_cli_source === 'jean' &&
                    codexStatus?.installed && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteCliTarget('codex')}
                      >
                        Delete managed install
                      </Button>
                    )}
                </div>
              </InlineField>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && (
        <SettingsSection
          title="OpenCode CLI"
          anchorId="pref-general-section-opencode-cli"
          actions={
            opencodeStatus?.installed ? (
              checkingOpenCodeAuth || isOpenCodeAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : opencodeAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenCodeRelogin}
                  >
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenCodeLogin}
                >
                  Login
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Not installed
              </span>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={opencodeStatus?.installed ? 'Version' : 'Status'}
              description={
                opencodeStatus?.installed
                  ? 'Enables OpenCode AI sessions'
                  : 'Optional — enables OpenCode AI sessions'
              }
            >
              {isOpenCodeLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : opencodeStatus?.installed ? (
                isOpencodePathSource ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {opencodeStatus.version ?? 'Installed'}
                    </span>
                    {isOpencodeVersionsLoading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!opencodeHasUpdate}
                        onClick={() => {
                          const action = getPathUpdateAction(
                            opencodeStatus.path,
                            opencodePathDetection?.package_manager,
                            'opencode',
                            ['upgrade']
                          )
                          if (action) {
                            openCliLoginModal(
                              'opencode',
                              action[0],
                              action[1],
                              'update'
                            )
                          } else {
                            openCliUpdateModal('opencode')
                          }
                        }}
                      >
                        {opencodeHasUpdate
                          ? `Update to ${opencodeLatestStable?.version}`
                          : 'Up to date'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={() => openCliUpdateModal('opencode')}
                  >
                    {opencodeStatus.version ?? 'Installed'}
                    <ChevronDown className="size-3" />
                  </Button>
                )
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={() => openCliUpdateModal('opencode')}
                >
                  Install
                </Button>
              )}
            </InlineField>
            {(opencodeStatus?.installed || opencodePathDetection?.found) && (
              <InlineField
                label="Source"
                description={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          handleCopyPath(
                            preferences?.opencode_cli_source === 'path'
                              ? opencodePathDetection?.path
                              : opencodeStatus?.path
                          )
                        }
                        className="text-left hover:underline cursor-pointer"
                      >
                        {preferences?.opencode_cli_source === 'path'
                          ? (opencodePathDetection?.path ?? 'System PATH')
                          : (opencodeStatus?.path ?? 'Not installed')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                }
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.opencode_cli_source ?? 'jean'}
                    onValueChange={handleOpencodeSourceChange}
                  >
                    <SelectTrigger className="w-96">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jean">Jean (managed)</SelectItem>
                      <SelectItem
                        value="path"
                        disabled={!opencodePathDetection?.found}
                      >
                        System PATH
                        {!opencodePathDetection?.found && ' (not found)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {preferences?.opencode_cli_source === 'jean' &&
                    opencodeStatus?.installed && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteCliTarget('opencode')}
                      >
                        Delete managed install
                      </Button>
                    )}
                </div>
              </InlineField>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && (
        <SettingsSection
          title={
            <span className="inline-flex items-center gap-2">
              <BackendLabel backend="cursor" />
              <span>CLI</span>
            </span>
          }
          anchorId="pref-general-section-cursor-cli"
          actions={
            cursorStatus?.installed ? (
              checkingCursorAuth || isCursorAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : cursorAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCursorRelogin}
                  >
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button variant="outline" size="sm" onClick={handleCursorLogin}>
                  Login
                </Button>
              )
            ) : (
              <Button variant="outline" size="sm" onClick={handleCursorInstall}>
                Install
              </Button>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={cursorStatus?.installed ? 'Version' : 'Status'}
              description={
                cursorStatus?.installed
                  ? 'Cursor Agent can be logged in and self-updated from Jean.'
                  : 'Cursor Agent can be installed from Jean or discovered from your system PATH.'
              }
            >
              {isCursorLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : cursorStatus?.installed ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {cursorStatus.version ?? 'Installed'}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCursorUpdate}
                  >
                    Run self-update
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Not found in PATH
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCursorInstall}
                  >
                    Install now
                  </Button>
                </div>
              )}
            </InlineField>
            {cursorStatus?.installed &&
              !cursorAuth?.authenticated &&
              cursorAuthMessage && (
                <div className="text-xs text-muted-foreground">
                  {cursorAuthMessage}
                </div>
              )}
            {(cursorStatus?.installed || cursorPathDetection?.found) && (
              <InlineField
                label="Source"
                description={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          handleCopyPath(
                            cursorPathDetection?.path ?? cursorStatus?.path
                          )
                        }
                        className="text-left hover:underline cursor-pointer"
                      >
                        {cursorPathDetection?.path ??
                          cursorStatus?.path ??
                          'System PATH'}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                }
              >
                <span className="text-sm text-muted-foreground">
                  System PATH
                </span>
              </InlineField>
            )}
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        title="Defaults"
        anchorId="pref-general-section-defaults"
      >
        <div className="space-y-4">
          <InlineField
            label="Default backend"
            description="CLI to use for new sessions"
          >
            <Select
              value={effectiveBackend}
              onValueChange={handleBackendChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {backendOptions
                  .filter(option =>
                    option.value === 'claude'
                      ? cliStatus?.installed
                      : option.value === 'codex'
                        ? codexStatus?.installed
                        : option.value === 'opencode'
                          ? opencodeStatus?.installed
                          : cursorStatus?.installed
                  )
                  .map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      <BackendLabel backend={option.value} />
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Default mode"
            description="Permission mode for new sessions"
          >
            <Select
              value={preferences?.default_execution_mode ?? 'plan'}
              onValueChange={(value: 'plan' | 'build' | 'yolo') => {
                patchPreferences.mutate({ default_execution_mode: value })
              }}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="plan">Plan</SelectItem>
                <SelectItem value="build">Build</SelectItem>
                <SelectItem value="yolo">Yolo</SelectItem>
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Build execution"
            description="Backend, model, thinking, and effort override when approving plans"
          >
            <div className="grid grid-cols-4 gap-2">
              <div>
                <Select
                  value={preferences?.build_backend ?? 'default'}
                  onValueChange={handleBuildBackendChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {buildBackendOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        <BackendLabel backend={option.value} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                {effectiveBuildBackend === 'opencode' ? (
                  <Popover
                    open={buildModelPopoverOpen}
                    onOpenChange={setBuildModelPopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={buildModelPopoverOpen}
                        className="w-full justify-between"
                      >
                        <span className="truncate text-left">
                          {preferences?.build_model
                            ? (openCodeModelOptions.find(
                                o => o.value === preferences.build_model
                              )?.label ??
                              formatOpenCodeModelLabelForSettings(
                                preferences.build_model
                              ))
                            : 'Default model'}
                        </span>
                        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 p-0">
                      <Command>
                        <CommandInput placeholder="Search models..." />
                        <CommandList onWheel={e => e.stopPropagation()}>
                          <CommandEmpty>No models found.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem
                              value="default"
                              onSelect={() => {
                                handleBuildModelChange('default')
                                setBuildModelPopoverOpen(false)
                              }}
                            >
                              Default model
                              <Check
                                className={cn(
                                  'ml-auto h-4 w-4',
                                  !preferences?.build_model ||
                                    preferences.build_model === 'default'
                                    ? 'opacity-100'
                                    : 'opacity-0'
                                )}
                              />
                            </CommandItem>
                            {openCodeModelOptions.map(option => (
                              <CommandItem
                                key={option.value}
                                value={`${option.label} ${option.value}`}
                                onSelect={() => {
                                  handleBuildModelChange(option.value)
                                  setBuildModelPopoverOpen(false)
                                }}
                              >
                                <span className="truncate">{option.label}</span>
                                <Check
                                  className={cn(
                                    'ml-auto h-4 w-4',
                                    preferences?.build_model === option.value
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                ) : effectiveBuildBackend === 'cursor' ? (
                  <Popover
                    open={buildModelPopoverOpen}
                    onOpenChange={setBuildModelPopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={buildModelPopoverOpen}
                        className="w-full justify-between"
                      >
                        <span className="truncate text-left">
                          {preferences?.build_model
                            ? (cursorModelOptions.find(
                                o => o.value === preferences.build_model
                              )?.label ??
                              formatCursorModelLabel(preferences.build_model))
                            : 'Default model'}
                        </span>
                        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 p-0">
                      <Command>
                        <CommandInput placeholder="Search models..." />
                        <CommandList onWheel={e => e.stopPropagation()}>
                          <CommandEmpty>No models found.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem
                              value="default"
                              onSelect={() => {
                                handleBuildModelChange('default')
                                setBuildModelPopoverOpen(false)
                              }}
                            >
                              Default model
                              <Check
                                className={cn(
                                  'ml-auto h-4 w-4',
                                  !preferences?.build_model ||
                                    preferences.build_model === 'default'
                                    ? 'opacity-100'
                                    : 'opacity-0'
                                )}
                              />
                            </CommandItem>
                            {cursorModelOptions.map(option => (
                              <CommandItem
                                key={option.value}
                                value={`${option.label} ${option.value}`}
                                onSelect={() => {
                                  handleBuildModelChange(option.value)
                                  setBuildModelPopoverOpen(false)
                                }}
                              >
                                <span className="truncate">{option.label}</span>
                                <Check
                                  className={cn(
                                    'ml-auto h-4 w-4',
                                    preferences?.build_model === option.value
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                ) : (
                  <Select
                    value={preferences?.build_model ?? 'default'}
                    onValueChange={handleBuildModelChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default model</SelectItem>
                      {(effectiveBuildBackend === 'codex'
                        ? codexDefaultModelOptions
                        : modelOptions
                      ).map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div>
                <Select
                  value={preferences?.build_thinking_level ?? 'default'}
                  onValueChange={handleBuildThinkingLevelChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default thinking</SelectItem>
                    {thinkingLevelOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Select
                  value={preferences?.build_effort_level ?? 'default'}
                  onValueChange={handleBuildEffortLevelChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      {effectiveBuildBackend === 'codex'
                        ? 'Default reasoning'
                        : 'Default effort'}
                    </SelectItem>
                    {(effectiveBuildBackend === 'codex'
                      ? codexReasoningOptions
                      : effortLevelOptions
                    ).map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </InlineField>

          <InlineField
            label="Yolo execution"
            description="Backend, model, thinking, and effort override when yolo-approving plans"
          >
            <div className="grid grid-cols-4 gap-2">
              <div>
                <Select
                  value={preferences?.yolo_backend ?? 'default'}
                  onValueChange={handleYoloBackendChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {backendOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        <BackendLabel backend={option.value} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                {effectiveYoloBackend === 'opencode' ? (
                  <Popover
                    open={yoloModelPopoverOpen}
                    onOpenChange={setYoloModelPopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={yoloModelPopoverOpen}
                        className="w-full justify-between"
                      >
                        <span className="truncate text-left">
                          {preferences?.yolo_model
                            ? (openCodeModelOptions.find(
                                o => o.value === preferences.yolo_model
                              )?.label ??
                              formatOpenCodeModelLabelForSettings(
                                preferences.yolo_model
                              ))
                            : 'Default model'}
                        </span>
                        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 p-0">
                      <Command>
                        <CommandInput placeholder="Search models..." />
                        <CommandList onWheel={e => e.stopPropagation()}>
                          <CommandEmpty>No models found.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem
                              value="default"
                              onSelect={() => {
                                handleYoloModelChange('default')
                                setYoloModelPopoverOpen(false)
                              }}
                            >
                              Default model
                              <Check
                                className={cn(
                                  'ml-auto h-4 w-4',
                                  !preferences?.yolo_model ||
                                    preferences.yolo_model === 'default'
                                    ? 'opacity-100'
                                    : 'opacity-0'
                                )}
                              />
                            </CommandItem>
                            {openCodeModelOptions.map(option => (
                              <CommandItem
                                key={option.value}
                                value={`${option.label} ${option.value}`}
                                onSelect={() => {
                                  handleYoloModelChange(option.value)
                                  setYoloModelPopoverOpen(false)
                                }}
                              >
                                <span className="truncate">{option.label}</span>
                                <Check
                                  className={cn(
                                    'ml-auto h-4 w-4',
                                    preferences?.yolo_model === option.value
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                ) : effectiveYoloBackend === 'cursor' ? (
                  <Popover
                    open={yoloModelPopoverOpen}
                    onOpenChange={setYoloModelPopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={yoloModelPopoverOpen}
                        className="w-full justify-between"
                      >
                        <span className="truncate text-left">
                          {preferences?.yolo_model
                            ? (cursorModelOptions.find(
                                o => o.value === preferences.yolo_model
                              )?.label ??
                              formatCursorModelLabel(preferences.yolo_model))
                            : 'Default model'}
                        </span>
                        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-80 p-0">
                      <Command>
                        <CommandInput placeholder="Search models..." />
                        <CommandList onWheel={e => e.stopPropagation()}>
                          <CommandEmpty>No models found.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem
                              value="default"
                              onSelect={() => {
                                handleYoloModelChange('default')
                                setYoloModelPopoverOpen(false)
                              }}
                            >
                              Default model
                              <Check
                                className={cn(
                                  'ml-auto h-4 w-4',
                                  !preferences?.yolo_model ||
                                    preferences.yolo_model === 'default'
                                    ? 'opacity-100'
                                    : 'opacity-0'
                                )}
                              />
                            </CommandItem>
                            {cursorModelOptions.map(option => (
                              <CommandItem
                                key={option.value}
                                value={`${option.label} ${option.value}`}
                                onSelect={() => {
                                  handleYoloModelChange(option.value)
                                  setYoloModelPopoverOpen(false)
                                }}
                              >
                                <span className="truncate">{option.label}</span>
                                <Check
                                  className={cn(
                                    'ml-auto h-4 w-4',
                                    preferences?.yolo_model === option.value
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                ) : (
                  <Select
                    value={preferences?.yolo_model ?? 'default'}
                    onValueChange={handleYoloModelChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default model</SelectItem>
                      {(effectiveYoloBackend === 'codex'
                        ? codexDefaultModelOptions
                        : modelOptions
                      ).map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div>
                <Select
                  value={preferences?.yolo_thinking_level ?? 'default'}
                  onValueChange={handleYoloThinkingLevelChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default thinking</SelectItem>
                    {thinkingLevelOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Select
                  value={preferences?.yolo_effort_level ?? 'default'}
                  onValueChange={handleYoloEffortLevelChange}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      {effectiveYoloBackend === 'codex'
                        ? 'Default reasoning'
                        : 'Default effort'}
                    </SelectItem>
                    {(effectiveYoloBackend === 'codex'
                      ? codexReasoningOptions
                      : effortLevelOptions
                    ).map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </InlineField>

          {/* Claude subsection */}
          <div className="pt-2">
            <div className="text-sm font-semibold text-foreground/80 mb-3">
              Claude
            </div>
          </div>

          <InlineField
            label="Model"
            description="Claude model for AI assistance"
          >
            <Select
              value={preferences?.selected_model ?? 'claude-opus-4-7[1m]'}
              onValueChange={handleModelChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Thinking"
            description="Claude Sonnet/traditional thinking level"
          >
            <Select
              value={preferences?.thinking_level ?? 'off'}
              onValueChange={handleThinkingLevelChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {thinkingLevelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Effort"
            description="Claude Opus adaptive effort (requires CLI 2.1.32+)"
          >
            <Select
              value={preferences?.default_effort_level ?? 'high'}
              onValueChange={handleEffortLevelChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {effortLevelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Chrome browser integration"
            description="Enable browser automation via Chrome extension"
          >
            <Switch
              checked={preferences?.chrome_enabled ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    chrome_enabled: checked,
                  })
                }
              }}
            />
          </InlineField>

          {/* Codex subsection */}
          <div className="pt-2">
            <div className="text-sm font-semibold text-foreground/80 mb-3">
              Codex
            </div>
          </div>

          <InlineField
            label="Model"
            description="Codex model for AI assistance"
          >
            <Select
              value={preferences?.selected_codex_model ?? 'gpt-5.5'}
              onValueChange={handleCodexModelChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {codexDefaultModelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Reasoning effort"
            description="Codex reasoning effort"
          >
            <Select
              value={preferences?.default_codex_reasoning_effort ?? 'high'}
              onValueChange={handleCodexReasoningChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {codexReasoningOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Multi-Agent"
            description="Allow Codex to spawn parallel subagents (experimental)"
          >
            <Switch
              checked={preferences?.codex_multi_agent_enabled ?? false}
              onCheckedChange={handleCodexMultiAgentToggle}
            />
          </InlineField>

          {preferences?.codex_multi_agent_enabled && (
            <InlineField
              label="Max agent threads"
              description="Maximum concurrent subagents (1–8)"
            >
              <Input
                type="number"
                min={1}
                max={8}
                className="w-20"
                value={preferences?.codex_max_agent_threads ?? 3}
                onChange={e => handleCodexMaxThreadsChange(e.target.value)}
              />
            </InlineField>
          )}

          {/* OpenCode subsection */}
          <div className="pt-2">
            <div className="text-sm font-semibold text-foreground/80 mb-3">
              OpenCode
            </div>
          </div>

          <InlineField
            label="Model"
            description="OpenCode model for AI assistance"
          >
            <Popover
              open={openCodeModelPopoverOpen}
              onOpenChange={setOpenCodeModelPopoverOpen}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={openCodeModelPopoverOpen}
                  aria-label="Select OpenCode model"
                  className="w-80 max-w-full justify-between"
                >
                  <span className="max-w-[16rem] truncate text-left">
                    {selectedOpenCodeModelLabel}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] p-0"
              >
                <Command>
                  <CommandInput placeholder="Search models..." />
                  <CommandList onWheel={e => e.stopPropagation()}>
                    <CommandEmpty>No models found.</CommandEmpty>
                    <CommandGroup>
                      {openCodeModelOptions.map(option => (
                        <CommandItem
                          key={option.value}
                          value={`${option.label} ${option.value}`}
                          onSelect={() => {
                            handleOpenCodeModelChange(option.value)
                            setOpenCodeModelPopoverOpen(false)
                          }}
                        >
                          <span className="max-w-[18rem] truncate">
                            {option.label}
                          </span>
                          <Check
                            className={cn(
                              'ml-auto h-4 w-4',
                              selectedOpenCodeModel === option.value
                                ? 'opacity-100'
                                : 'opacity-0'
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </InlineField>

          {/* Cursor subsection */}
          <div className="pt-2">
            <div className="mb-3 text-sm font-semibold text-foreground/80">
              <BackendLabel backend="cursor" />
            </div>
          </div>

          <InlineField
            label="Model"
            description="Cursor model for AI assistance"
          >
            <Popover
              open={cursorModelPopoverOpen}
              onOpenChange={setCursorModelPopoverOpen}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={cursorModelPopoverOpen}
                  aria-label="Select Cursor model"
                  className="w-80 max-w-full justify-between"
                >
                  <span className="max-w-[16rem] truncate text-left">
                    {selectedCursorModelLabel}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] p-0"
              >
                <Command>
                  <CommandInput placeholder="Search models..." />
                  <CommandList onWheel={e => e.stopPropagation()}>
                    <CommandEmpty>No models found.</CommandEmpty>
                    <CommandGroup>
                      {cursorModelOptions.map(option => (
                        <CommandItem
                          key={option.value}
                          value={`${option.label} ${option.value}`}
                          onSelect={() => {
                            handleCursorModelChange(option.value)
                            setCursorModelPopoverOpen(false)
                          }}
                        >
                          <span className="max-w-[18rem] truncate">
                            {option.label}
                          </span>
                          <Check
                            className={cn(
                              'ml-auto h-4 w-4',
                              selectedCursorModel === option.value
                                ? 'opacity-100'
                                : 'opacity-0'
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </InlineField>

          {/* Shared settings */}
          <div className="pt-2">
            <div className="text-sm font-semibold text-foreground/80 mb-3">
              General
            </div>
          </div>

          <AiLanguageField
            preferences={preferences}
            patchPreferences={patchPreferences}
          />

          <InlineField
            label="Allow web tools in plan mode"
            description="WebFetch/WebSearch for Claude, --search for Codex"
          >
            <Switch
              checked={preferences?.allow_web_tools_in_plan_mode ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    allow_web_tools_in_plan_mode: checked,
                  })
                }
              }}
            />
          </InlineField>

          {isNativeApp() && (
            <InlineField label="Editor" description="App to open worktrees in">
              <Select
                value={preferences?.editor ?? 'zed'}
                onValueChange={handleEditorChange}
              >
                <SelectTrigger className="w-full sm:min-w-96">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {editorOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>
          )}

          {isNativeApp() && (
            <InlineField
              label="Terminal"
              description="App to open terminals in"
            >
              <Select
                value={preferences?.terminal ?? 'terminal'}
                onValueChange={handleTerminalChange}
              >
                <SelectTrigger className="w-full sm:min-w-96">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {terminalOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>
          )}

          {isNativeApp() && (
            <InlineField
              label="Open In"
              description="Default app for Open button"
            >
              <Select
                value={preferences?.open_in ?? 'editor'}
                onValueChange={handleOpenInChange}
              >
                <SelectTrigger className="w-full sm:min-w-96">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {openInDefaultOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>
          )}

          <InlineField
            label="Git poll interval"
            description="Check for branch updates when focused"
          >
            <Select
              value={String(preferences?.git_poll_interval ?? 60)}
              onValueChange={handleGitPollIntervalChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {gitPollIntervalOptions.map(option => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Remote poll interval"
            description="Check for PR status updates"
          >
            <Select
              value={String(preferences?.remote_poll_interval ?? 60)}
              onValueChange={handleRemotePollIntervalChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {remotePollIntervalOptions.map(option => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Auto-update AI backends"
            description="Install Claude, Codex, OpenCode, and GitHub CLI updates in the background as soon as a new version is detected."
          >
            <Switch
              checked={preferences?.auto_update_ai_backends ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    auto_update_ai_backends: checked,
                  })
                }
              }}
            />
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Notifications"
        anchorId="pref-general-section-notifications"
      >
        <div className="space-y-4">
          <InlineField
            label="Waiting sound"
            description="Play when session needs your input"
          >
            <div className="flex items-center gap-2">
              <Select
                value={preferences?.waiting_sound ?? 'none'}
                onValueChange={handleWaitingSoundChange}
              >
                <SelectTrigger className="w-full sm:min-w-96">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {notificationSoundOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                disabled={
                  !preferences?.waiting_sound ||
                  preferences.waiting_sound === 'none'
                }
                onClick={() =>
                  playNotificationSound(preferences?.waiting_sound ?? 'none')
                }
              >
                <Play className="h-4 w-4" />
              </Button>
            </div>
          </InlineField>

          <InlineField
            label="Review sound"
            description="Play when session finishes"
          >
            <div className="flex items-center gap-2">
              <Select
                value={preferences?.review_sound ?? 'none'}
                onValueChange={handleReviewSoundChange}
              >
                <SelectTrigger className="w-full sm:min-w-96">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {notificationSoundOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                disabled={
                  !preferences?.review_sound ||
                  preferences.review_sound === 'none'
                }
                onClick={() =>
                  playNotificationSound(preferences?.review_sound ?? 'none')
                }
              >
                <Play className="h-4 w-4" />
              </Button>
            </div>
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Auto-generate"
        anchorId="pref-general-section-auto-generate"
      >
        <div className="space-y-4">
          <InlineField
            label="Branch names"
            description="Generate branch names from your first message"
          >
            <Switch
              checked={preferences?.auto_branch_naming ?? true}
              onCheckedChange={handleAutoBranchNamingChange}
            />
          </InlineField>
          <InlineField
            label="Session names"
            description="Generate session names from your first message"
          >
            <Switch
              checked={preferences?.auto_session_naming ?? true}
              onCheckedChange={handleAutoSessionNamingChange}
            />
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Worktrees"
        anchorId="pref-general-section-worktrees"
      >
        <div className="space-y-4">
          <InlineField
            label="Auto-pull base branch"
            description="Pull the latest changes before creating a new worktree"
          >
            <Switch
              checked={preferences?.auto_pull_base_branch ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    auto_pull_base_branch: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Auto-save context"
            description="Automatically save session context after each AI response"
          >
            <Switch
              checked={preferences?.auto_save_context ?? false}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    auto_save_context: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Restore last session on project switch"
            description="Automatically reopen the last worktree and session when switching projects"
          >
            <Switch
              checked={preferences?.restore_last_session ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    restore_last_session: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Expand tool calls by default"
            description="Automatically expand tool call details in chat instead of showing a collapsed summary"
          >
            <Switch
              checked={preferences?.expand_tool_calls_by_default ?? false}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    expand_tool_calls_by_default: checked,
                  })
                }
              }}
            />
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection title="Archive" anchorId="pref-general-section-archive">
        <div className="space-y-4">
          <InlineField
            label="Confirm before closing"
            description="Show confirmation dialog when closing sessions or worktrees"
          >
            <Switch
              checked={preferences?.confirm_session_close ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    confirm_session_close: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Close original session on clear context"
            description="Automatically close the original session when using Clear Context and yolo"
          >
            <Switch
              checked={preferences?.close_original_on_clear_context ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    close_original_on_clear_context: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Removal behavior"
            description="What happens when closing sessions or worktrees"
          >
            <Select
              value={preferences?.removal_behavior ?? 'delete'}
              onValueChange={(value: RemovalBehavior) => {
                if (preferences) {
                  patchPreferences.mutate({
                    removal_behavior: value,
                  })
                }
              }}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {removalBehaviorOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Auto-archive on PR merge"
            description="Archive worktrees when their PR is merged"
          >
            <Switch
              checked={preferences?.auto_archive_on_pr_merged ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  patchPreferences.mutate({
                    auto_archive_on_pr_merged: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Auto-delete archives"
            description="Delete archived items older than this"
          >
            <Select
              value={String(preferences?.archive_retention_days ?? 30)}
              onValueChange={handleArchiveRetentionChange}
            >
              <SelectTrigger className="w-full sm:min-w-96">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {archiveRetentionOptions.map(option => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Delete all archives"
            description="Permanently delete all archived worktrees and sessions"
          >
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowDeleteAllDialog(true)}
              disabled={isDeleting}
            >
              Delete All
            </Button>
          </InlineField>
        </div>
      </SettingsSection>

      {isNativeApp() && (
        <SettingsSection
          title="Troubleshooting"
          anchorId="pref-general-section-troubleshooting"
        >
          <div className="space-y-4">
            <InlineField
              label="Application logs"
              description="Open the log directory for troubleshooting"
            >
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await invoke('open_log_directory')
                  } catch (error) {
                    toast.error(`Failed to open logs: ${error}`)
                  }
                }}
              >
                Show Logs
              </Button>
            </InlineField>
          </div>
        </SettingsSection>
      )}

      <AlertDialog
        open={showDeleteAllDialog}
        onOpenChange={setShowDeleteAllDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all archives?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all archived worktrees and sessions,
              including their git branches and worktree directories. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAllArchives}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteCliTarget !== null}
        onOpenChange={open => {
          if (!open) setDeleteCliTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete Jean-managed{' '}
              {deleteCliTarget === 'claude'
                ? 'Claude CLI'
                : deleteCliTarget === 'codex'
                  ? 'Codex CLI'
                  : deleteCliTarget === 'opencode'
                    ? 'OpenCode CLI'
                    : 'GitHub CLI'}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const pathFound =
                  deleteCliTarget === 'claude'
                    ? pathDetection?.found
                    : deleteCliTarget === 'codex'
                      ? codexPathDetection?.found
                      : deleteCliTarget === 'opencode'
                        ? opencodePathDetection?.found
                        : deleteCliTarget === 'gh'
                          ? ghPathDetection?.found
                          : false
                return pathFound
                  ? 'The Jean-managed binary will be removed and the source will switch to System PATH. You can reinstall it later from this page.'
                  : 'The Jean-managed binary will be removed. No System PATH version was detected, so this backend will be unavailable until you reinstall it.'
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingCli}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDeleteCli}
              disabled={isDeletingCli}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingCli ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const AiLanguageField: FC<{
  preferences: AppPreferences | undefined
  patchPreferences: ReturnType<typeof usePatchPreferences>
}> = ({ preferences, patchPreferences }) => {
  const [localValue, setLocalValue] = useState(preferences?.ai_language ?? '')

  const hasChanges = localValue !== (preferences?.ai_language ?? '')

  const handleSave = useCallback(() => {
    if (!preferences) return
    patchPreferences.mutate({ ai_language: localValue })
  }, [preferences, patchPreferences, localValue])

  return (
    <InlineField
      label="AI Language"
      description="Language for AI responses (e.g. French, 日本語)"
    >
      <div className="flex items-center gap-2">
        <Input
          className="w-full sm:w-40"
          placeholder="Default"
          value={localValue}
          onChange={e => setLocalValue(e.target.value)}
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!hasChanges || patchPreferences.isPending}
        >
          {patchPreferences.isPending && (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          Save
        </Button>
      </div>
    </InlineField>
  )
}
