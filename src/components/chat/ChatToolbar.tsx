import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Zap } from 'lucide-react'
import { dismissibleToast } from '@/lib/dismissible-toast'
import { useUIStore } from '@/store/ui-store'
import {
  gitPush,
  triggerImmediateGitPoll,
  fetchWorktreesStatus,
  performGitPull,
} from '@/services/git-status'
import { useChatStore } from '@/store/chat-store'
import { useRemotePicker } from '@/hooks/useRemotePicker'
import { useAllBackendsMcpHealth } from '@/services/mcp'
import { getModelFastInfo, type ClaudeModel } from '@/types/preferences'
import {
  getSupportedExecutionModes,
  type EffortLevel,
  type ThinkingLevel,
} from '@/types/chat'
import type { ChatToolbarProps } from '@/components/chat/toolbar/types'
import { MobileToolbarMenu } from '@/components/chat/toolbar/MobileToolbarMenu'
import { MobileSettingsMenu } from '@/components/chat/toolbar/MobileSettingsMenu'
import { MobileBackendModelPickerSheet } from '@/components/chat/toolbar/MobileBackendModelPickerSheet'
import { DesktopToolbarControls } from '@/components/chat/toolbar/DesktopToolbarControls'
import { DockBurgerButton } from '@/components/chat/toolbar/DockBurgerButton'
import { ExecutionModeDropdown } from '@/components/chat/toolbar/ExecutionModeDropdown'
import { SendCancelButton } from '@/components/chat/toolbar/SendCancelButton'
import { ContextViewerDialog } from '@/components/chat/toolbar/ContextViewerDialog'
import {
  CODEX_MODEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { useToolbarDropdownShortcuts } from '@/components/chat/toolbar/useToolbarDropdownShortcuts'
import { useToolbarDerivedState } from '@/components/chat/toolbar/useToolbarDerivedState'
import { useContextViewer } from '@/components/chat/toolbar/useContextViewer'
import { formatOpencodeModelLabel } from '@/components/chat/toolbar/toolbar-utils'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  BackendLabel,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'

// eslint-disable-next-line react-refresh/only-export-components
export {
  MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
}
export type { ChatToolbarProps }

export const ChatToolbar = memo(function ChatToolbar({
  isSending,
  hasPendingQuestions,
  hasPendingAttachments,
  hasInputValue,
  executionMode,
  selectedBackend,
  selectedModel,
  selectedProvider,
  selectedThinkingLevel,
  selectedEffortLevel,
  useAdaptiveThinking,
  hideThinkingLevel,
  sessionHasMessages,
  providerLocked,
  baseBranch,
  prUrl,
  prNumber,
  displayStatus,
  checkStatus,
  mergeableStatus,
  activeWorktreePath,
  worktreeId,
  activeSessionId,
  projectId,
  loadedIssueContexts,
  loadedPRContexts,
  loadedSecurityContexts,
  loadedAdvisoryContexts,
  loadedLinearContexts,
  attachedSavedContexts,
  onOpenMagicModal,
  onSaveContext,
  onLoadContext,
  onCommit,
  onCommitAndPush,
  onOpenPr,
  onReview,
  onMerge,
  onMergePr,
  onResolvePrConflicts,
  onResolveConflicts,
  hasOpenPr,
  installedBackends,
  onModelChange,
  onBackendModelChange,
  onProviderChange,
  customCliProfiles,
  onThinkingLevelChange,
  onEffortLevelChange,
  onSetExecutionMode,
  onAttach,
  onCancel,
  queuedMessageCount,
  availableMcpServers,
  enabledMcpServers,
  onToggleMcpServer,
  onOpenProjectSettings,
}: ChatToolbarProps) {
  const {
    statuses: mcpStatuses,
    isFetching: isHealthChecking,
    refetchAll: checkHealth,
  } = useAllBackendsMcpHealth(installedBackends, activeWorktreePath)

  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false)
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false)
  const [mcpDropdownOpen, setMcpDropdownOpen] = useState(false)
  const [mobileBackendModelPickerOpen, setMobileBackendModelPickerOpen] =
    useState(false)
  const isMobile = useIsMobile()

  const pickRemoteOrRun = useRemotePicker(activeWorktreePath)

  const handleMcpDropdownOpenChange = useCallback(
    (open: boolean) => {
      setMcpDropdownOpen(open)
      if (open) {
        checkHealth()
      }
    },
    [checkHealth]
  )

  useToolbarDropdownShortcuts({
    setProviderDropdownOpen,
    setThinkingDropdownOpen,
  })

  // Signal to FloatingDock that its burger counterpart now lives in this toolbar.
  useEffect(() => {
    const { setChatToolbarMounted } = useUIStore.getState()
    setChatToolbarMounted(true)
    return () => setChatToolbarMounted(false)
  }, [])

  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: selectedBackend === 'opencode',
  })
  const opencodeModelOptions =
    availableOpencodeModels?.map(model => ({
      value: model,
      label: formatOpencodeModelLabel(model),
    })) ?? OPENCODE_MODEL_OPTIONS

  const { isCodex, activeMcpCount, selectedModelLabel } =
    useToolbarDerivedState({
      selectedBackend,
      selectedProvider,
      selectedModel,
      opencodeModelOptions,
      customCliProfiles,
      availableMcpServers,
      enabledMcpServers,
    })
  const availableExecutionModes = getSupportedExecutionModes(selectedBackend)

  const backendModelLabel = useMemo(
    () => (
      <>
        <BackendLabel
          backend={selectedBackend}
          badgeClassName="text-[9px] leading-3"
        />
        <span className="truncate">· {selectedModelLabel}</span>
        {getModelFastInfo(selectedBackend, selectedModel).isFast && (
          <Zap
            className="h-3 w-3 shrink-0 fill-current text-yellow-500"
            aria-label="Fast mode"
          />
        )}
      </>
    ),
    [selectedBackend, selectedModel, selectedModelLabel]
  )

  const backendModelLabelText = useMemo(
    () => `${getBackendPlainLabel(selectedBackend)} · ${selectedModelLabel}`,
    [selectedBackend, selectedModelLabel]
  )

  const {
    viewingContext,
    setViewingContext,
    handleViewIssue,
    handleViewPR,
    handleViewSavedContext,
    handleViewSecurityAlert,
    handleViewAdvisory,
    handleViewLinear,
  } = useContextViewer({
    activeSessionId,
    activeWorktreePath,
    worktreeId,
    projectId,
  })

  const handleModelChange = useCallback(
    (value: string) => {
      onModelChange(value as ClaudeModel)
    },
    [onModelChange]
  )

  const handleProviderChange = useCallback(
    (value: string) => {
      const provider = value === 'default' ? null : value
      onProviderChange(provider)
      if (provider && provider !== '__anthropic__') {
        if (selectedModel === 'claude-opus-4-7[1m]') {
          onModelChange('claude-opus-4-7' as ClaudeModel)
        } else if (
          selectedModel === 'claude-opus-4-6[1m]' ||
          selectedModel === 'claude-sonnet-4-6[1m]' ||
          selectedModel === 'claude-opus-4-6-fast' ||
          selectedModel === 'claude-opus-4-6[1m]-fast'
        ) {
          onModelChange('claude-opus-4-6' as ClaudeModel)
        }
      }
    },
    [onProviderChange, onModelChange, selectedModel]
  )

  const handleThinkingLevelChange = useCallback(
    (value: string) => {
      onThinkingLevelChange(value as ThinkingLevel)
    },
    [onThinkingLevelChange]
  )

  const handleEffortLevelChange = useCallback(
    (value: string) => {
      onEffortLevelChange(value as EffortLevel)
    },
    [onEffortLevelChange]
  )

  const handlePullClick = useCallback(async () => {
    if (!activeWorktreePath || !worktreeId) return
    await performGitPull({
      worktreeId,
      worktreePath: activeWorktreePath,
      baseBranch,
      projectId,
      onMergeConflict: onResolveConflicts,
    })
  }, [
    activeWorktreePath,
    baseBranch,
    worktreeId,
    projectId,
    onResolveConflicts,
  ])

  const handlePushClick = useCallback(() => {
    if (!activeWorktreePath || !worktreeId) return
    pickRemoteOrRun(async remote => {
      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()
      setWorktreeLoading(worktreeId, 'push')
      const opToast = dismissibleToast.loading('Pushing changes...')
      try {
        const result = await gitPush(activeWorktreePath, prNumber, remote)
        triggerImmediateGitPoll()
        if (projectId) fetchWorktreesStatus(projectId)
        if (result.fellBack) {
          opToast.warning(
            'Could not push to PR branch, pushed to new branch instead'
          )
        } else {
          opToast.success('Changes pushed')
        }
      } catch (error) {
        opToast.error(`Push failed: ${error}`)
      } finally {
        clearWorktreeLoading(worktreeId)
      }
    })
  }, [activeWorktreePath, worktreeId, projectId, prNumber, pickRemoteOrRun])

  const canSend = hasInputValue || hasPendingAttachments

  return (
    <div className="@container flex justify-start px-4 py-2 md:px-6">
      <div className="inline-flex max-w-full flex-nowrap items-center overflow-x-auto whitespace-nowrap bg-transparent scrollbar-hide">
        <DockBurgerButton
          activeMcpCount={activeMcpCount}
          className="flex @xl:hidden"
        />

        <MobileToolbarMenu
          isDisabled={isSending || hasPendingQuestions}
          hasOpenPr={hasOpenPr}
          onSaveContext={onSaveContext}
          onLoadContext={onLoadContext}
          onCommit={onCommit}
          onCommitAndPush={onCommitAndPush}
          onOpenPr={onOpenPr}
          onReview={onReview}
          onMerge={onMerge}
          onMergePr={onMergePr}
          handlePullClick={handlePullClick}
          handlePushClick={handlePushClick}
        />

        <MobileSettingsMenu
          isDisabled={isSending || hasPendingQuestions}
          providerLocked={providerLocked}
          selectedBackend={selectedBackend}
          selectedProvider={selectedProvider}
          backendModelLabel={backendModelLabel}
          backendModelLabelText={backendModelLabelText}
          selectedEffortLevel={selectedEffortLevel}
          selectedThinkingLevel={selectedThinkingLevel}
          hideThinkingLevel={hideThinkingLevel}
          useAdaptiveThinking={useAdaptiveThinking}
          isCodex={isCodex}
          customCliProfiles={customCliProfiles}
          onOpenBackendModelPicker={() => setMobileBackendModelPickerOpen(true)}
          handleProviderChange={handleProviderChange}
          handleEffortLevelChange={handleEffortLevelChange}
          handleThinkingLevelChange={handleThinkingLevelChange}
          loadedIssueContexts={loadedIssueContexts}
          loadedPRContexts={loadedPRContexts}
          loadedSecurityContexts={loadedSecurityContexts}
          loadedAdvisoryContexts={loadedAdvisoryContexts}
          loadedLinearContexts={loadedLinearContexts}
          attachedSavedContexts={attachedSavedContexts}
          handleViewIssue={handleViewIssue}
          handleViewPR={handleViewPR}
          handleViewSecurityAlert={handleViewSecurityAlert}
          handleViewAdvisory={handleViewAdvisory}
          handleViewLinear={handleViewLinear}
          handleViewSavedContext={handleViewSavedContext}
          availableMcpServers={availableMcpServers}
          enabledMcpServers={enabledMcpServers}
          activeMcpCount={activeMcpCount}
          onToggleMcpServer={onToggleMcpServer}
          prUrl={prUrl}
          prNumber={prNumber}
          prDisplayStatus={displayStatus}
          worktreeId={worktreeId}
          onAttach={onAttach}
        />

        {isMobile && (
          <MobileBackendModelPickerSheet
            open={mobileBackendModelPickerOpen}
            onOpenChange={setMobileBackendModelPickerOpen}
            sessionHasMessages={sessionHasMessages}
            providerLocked={providerLocked}
            selectedBackend={selectedBackend}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            installedBackends={installedBackends}
            customCliProfiles={customCliProfiles}
            onModelChange={handleModelChange}
            onBackendModelChange={onBackendModelChange}
          />
        )}

        <div className="block @xl:hidden h-4 w-px shrink-0 bg-border/50" />

        <ExecutionModeDropdown
          executionMode={executionMode}
          availableModes={availableExecutionModes}
          disabled={hasPendingQuestions}
          onSetExecutionMode={onSetExecutionMode}
          className="flex @xl:hidden shrink-0"
          align="end"
        />

        <DesktopToolbarControls
          hasPendingQuestions={hasPendingQuestions}
          selectedBackend={selectedBackend}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedThinkingLevel={selectedThinkingLevel}
          selectedEffortLevel={selectedEffortLevel}
          executionMode={executionMode}
          useAdaptiveThinking={useAdaptiveThinking}
          hideThinkingLevel={hideThinkingLevel}
          sessionHasMessages={sessionHasMessages}
          providerLocked={providerLocked}
          customCliProfiles={customCliProfiles}
          isCodex={isCodex}
          prUrl={prUrl}
          prNumber={prNumber}
          displayStatus={displayStatus}
          checkStatus={checkStatus}
          mergeableStatus={mergeableStatus}
          activeWorktreePath={activeWorktreePath}
          availableMcpServers={availableMcpServers}
          enabledMcpServers={enabledMcpServers}
          activeMcpCount={activeMcpCount}
          isHealthChecking={isHealthChecking}
          mcpStatuses={mcpStatuses}
          loadedIssueContexts={loadedIssueContexts}
          loadedPRContexts={loadedPRContexts}
          loadedSecurityContexts={loadedSecurityContexts}
          loadedAdvisoryContexts={loadedAdvisoryContexts}
          loadedLinearContexts={loadedLinearContexts}
          attachedSavedContexts={attachedSavedContexts}
          providerDropdownOpen={providerDropdownOpen}
          thinkingDropdownOpen={thinkingDropdownOpen}
          mcpDropdownOpen={mcpDropdownOpen}
          setProviderDropdownOpen={setProviderDropdownOpen}
          setThinkingDropdownOpen={setThinkingDropdownOpen}
          onMcpDropdownOpenChange={handleMcpDropdownOpenChange}
          onOpenMagicModal={onOpenMagicModal}
          onOpenProjectSettings={onOpenProjectSettings}
          onResolvePrConflicts={onResolvePrConflicts}
          onLoadContext={onLoadContext}
          onAttach={onAttach}
          installedBackends={installedBackends}
          onSetExecutionMode={onSetExecutionMode}
          availableExecutionModes={availableExecutionModes}
          onToggleMcpServer={onToggleMcpServer}
          handleModelChange={handleModelChange}
          handleBackendModelChange={onBackendModelChange}
          handleProviderChange={handleProviderChange}
          handleThinkingLevelChange={handleThinkingLevelChange}
          handleEffortLevelChange={handleEffortLevelChange}
          handleViewIssue={handleViewIssue}
          handleViewPR={handleViewPR}
          handleViewSecurityAlert={handleViewSecurityAlert}
          handleViewAdvisory={handleViewAdvisory}
          handleViewLinear={handleViewLinear}
          handleViewSavedContext={handleViewSavedContext}
        />

        <div className="h-4 w-px shrink-0 bg-border/50" />

        <div className="shrink-0">
          <SendCancelButton
            isSending={isSending}
            canSend={canSend}
            queuedMessageCount={queuedMessageCount}
            onCancel={onCancel}
          />
        </div>
      </div>

      <ContextViewerDialog
        viewingContext={viewingContext}
        onClose={() => setViewingContext(null)}
      />
    </div>
  )
})
