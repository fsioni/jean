import { useCallback, type RefObject } from 'react'
import { generateId } from '@/lib/uuid'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import {
  chatQueryKeys,
  cancelChatMessage,
  persistEnqueue,
} from '@/services/chat'
import { skillQueryKeys } from '@/services/skills'
import { buildMcpConfigJson } from '@/services/mcp'
import { buildMessageWithRefs } from '@/components/chat/message-with-refs'
import { DEFAULT_PARALLEL_EXECUTION_PROMPT } from '@/types/preferences'
import type {
  QueuedMessage,
  ExecutionMode,
  ThinkingLevel,
  EffortLevel,
  McpServerInfo,
  Session,
} from '@/types/chat'
import type { QueryClient } from '@tanstack/react-query'
import { GIT_ALLOWED_TOOLS } from './useMessageHandlers'

interface UseMessageSendingParams {
  activeSessionId: string | null | undefined
  activeWorktreeId: string | null | undefined
  activeWorktreePath: string | null | undefined
  inputRef: RefObject<HTMLTextAreaElement | null>
  selectedModelRef: RefObject<string>
  selectedProviderRef: RefObject<string | null>
  selectedThinkingLevelRef: RefObject<ThinkingLevel>
  selectedEffortLevelRef: RefObject<EffortLevel>
  executionModeRef: RefObject<ExecutionMode>
  useAdaptiveThinkingRef: RefObject<boolean>
  isCodexBackendRef: RefObject<boolean>
  mcpServersDataRef: RefObject<McpServerInfo[] | undefined>
  enabledMcpServersRef: RefObject<string[]>
  selectedBackendRef: RefObject<'claude' | 'codex' | 'opencode' | 'cursor'>
  preferences:
    | {
        custom_cli_profiles?: { name: string }[]
        parallel_execution_prompt_enabled?: boolean
        magic_prompts?: { parallel_execution?: string | null }
        chrome_enabled?: boolean
        ai_language?: string
        codex_goal_execution_mode?: 'build' | 'yolo'
      }
    | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessage: { mutate: (args: any, opts?: any) => void }
  queryClient: QueryClient
  markAtBottom: () => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionsData: any
  setInputDraft: (sessionId: string, draft: string) => void
  clearInputDraft: (sessionId: string) => void
  clearChatInputState: () => void
}

/**
 * Core message sending pipeline: resolveCustomProfile, buildMessageWithRefs,
 * sendMessageNow, handleSubmit, handleGitDiff handlers, and review-fix-message listener.
 */
export function useMessageSending({
  activeSessionId,
  activeWorktreeId,
  activeWorktreePath,
  inputRef,
  selectedModelRef,
  selectedProviderRef,
  selectedThinkingLevelRef,
  selectedEffortLevelRef,
  executionModeRef,
  useAdaptiveThinkingRef,
  isCodexBackendRef,
  mcpServersDataRef,
  enabledMcpServersRef,
  selectedBackendRef,
  preferences,
  sendMessage,
  queryClient,
  markAtBottom,
  sessionsData,
  setInputDraft,
  clearInputDraft,
  clearChatInputState,
}: UseMessageSendingParams) {
  // Helper to resolve custom CLI profile name for the active provider
  const resolveCustomProfile = useCallback(
    (model: string, provider: string | null) => {
      if (!provider || provider === '__anthropic__')
        return { model, customProfileName: undefined }
      const profile = preferences?.custom_cli_profiles?.find(
        p => p.name === provider
      )
      return {
        model,
        customProfileName: profile?.name,
      }
    },
    [preferences?.custom_cli_profiles]
  )

  // Helper to send a queued message immediately
  const sendMessageNow = useCallback(
    (queuedMsg: QueuedMessage) => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      console.log(
        `[Send] sendMessageNow sessionId=${activeSessionId} worktreeId=${activeWorktreeId}`
      )

      const {
        setLastSentMessage,
        setError,
        setExecutingMode,
        setSelectedModel,
        getApprovedTools,
        clearStreamingContent,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()

      clearStreamingContent(activeSessionId)
      clearToolCalls(activeSessionId)
      clearStreamingContentBlocks(activeSessionId)

      setLastSentMessage(activeSessionId, queuedMsg.message)
      setError(activeSessionId, null)
      // NOTE: addSendingSession is called in onMutate (chat.ts) so it batches
      // with the optimistic user message in a single React render pass.
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(activeWorktreeId),
      })
      setExecutingMode(activeSessionId, queuedMsg.executionMode)
      setSelectedModel(activeSessionId, queuedMsg.model)

      const sessionApprovedTools = getApprovedTools(activeSessionId)
      const mergedAllowedTools = [
        ...GIT_ALLOWED_TOOLS,
        ...(sessionApprovedTools.length > 0 ? sessionApprovedTools : []),
        ...(queuedMsg.commandAllowedTools ?? []),
      ]
      const allowedTools =
        mergedAllowedTools.length > 0
          ? [...new Set(mergedAllowedTools)]
          : undefined

      const fullMessage = buildMessageWithRefs(queuedMsg)
      const resolved = resolveCustomProfile(queuedMsg.model, queuedMsg.provider)

      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message: fullMessage,
          model: resolved.model,
          executionMode: queuedMsg.executionMode,
          thinkingLevel: queuedMsg.thinkingLevel,
          effortLevel: queuedMsg.effortLevel,
          mcpConfig: queuedMsg.mcpConfig,
          customProfileName: resolved.customProfileName,
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
          allowedTools,
          backend: queuedMsg.backend,
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      sendMessage,
      queryClient,
      preferences?.parallel_execution_prompt_enabled,
      preferences?.chrome_enabled,
      preferences?.ai_language,
      preferences?.magic_prompts?.parallel_execution,
      resolveCustomProfile,
    ]
  )

  // GitDiffModal: add diff reference to input
  const handleGitDiffAddToPrompt = useCallback(
    (reference: string) => {
      if (activeSessionId) {
        const { inputDrafts } = useChatStore.getState()
        const currentInput = inputDrafts[activeSessionId] ?? ''
        const separator = currentInput.length > 0 ? '\n' : ''
        setInputDraft(
          activeSessionId,
          `${currentInput}${separator}${reference}`
        )
      }
    },
    [activeSessionId, setInputDraft]
  )

  // GitDiffModal: execute diff prompt immediately
  const handleGitDiffExecutePrompt = useCallback(
    (reference: string) => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      const {
        inputDrafts,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        clearInputDraft: clearDraft,
      } = useChatStore.getState()
      const currentInput = inputDrafts[activeSessionId] ?? ''
      const separator = currentInput.length > 0 ? '\n' : ''
      const message = `${currentInput}${separator}${reference}`

      const model = selectedModelRef.current
      const thinkingLevel = selectedThinkingLevelRef.current

      setLastSentMessage(activeSessionId, message)
      setError(activeSessionId, null)
      clearDraft(activeSessionId)
      // NOTE: addSendingSession is called in onMutate (chat.ts) so it batches
      // with the optimistic user message in a single React render pass.
      setSelectedModel(activeSessionId, model)
      setExecutingMode(activeSessionId, 'build')

      const diffResolved = resolveCustomProfile(
        model,
        selectedProviderRef.current
      )
      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message,
          model: diffResolved.model,
          customProfileName: diffResolved.customProfileName,
          executionMode: 'build',
          thinkingLevel,
          effortLevel:
            useAdaptiveThinkingRef.current || isCodexBackendRef.current
              ? selectedEffortLevelRef.current
              : undefined,
          mcpConfig: buildMcpConfigJson(
            mcpServersDataRef.current ?? [],
            enabledMcpServersRef.current,
            selectedBackendRef.current
          ),
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
          backend:
            selectedBackendRef.current !== 'claude'
              ? selectedBackendRef.current
              : undefined,
        },
        { onSettled: () => inputRef.current?.focus() }
      )
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      preferences,
      sendMessage,
      resolveCustomProfile,
    ]
  )

  // Form submit handler
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()

      const {
        inputDrafts,
        getPendingImages,
        clearPendingImages,
        getPendingFiles,
        clearPendingFiles,
        getPendingTextFiles,
        clearPendingTextFiles,
        getPendingSkills,
        clearPendingSkills,
        enqueueMessage,
        isSending: checkIsSendingNow,
        setSessionReviewing,
        setExecutionMode,
      } = useChatStore.getState()
      const liveInputValue = inputRef.current?.value
      const textMessage = (
        liveInputValue ??
        inputDrafts[activeSessionId ?? ''] ??
        ''
      ).trim()
      const images = getPendingImages(activeSessionId ?? '')
      const files = getPendingFiles(activeSessionId ?? '')
      const skills = getPendingSkills(activeSessionId ?? '')
      const textFiles = getPendingTextFiles(activeSessionId ?? '')

      if (
        !textMessage &&
        images.length === 0 &&
        files.length === 0 &&
        textFiles.length === 0 &&
        skills.length === 0
      )
        return
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      if (
        sessionsData &&
        !sessionsData.sessions.some(
          (s: { id: string }) => s.id === activeSessionId
        )
      ) {
        toast.error(
          'Session not found. Please refresh or create a new session.'
        )
        return
      }

      let message = textMessage
      let startedCodexGoalTurn = false
      // Intercept Codex /goal slash. /goal alone and /goal clear are
      // pure RPC calls (no turn); /goal <objective> sets the goal, switches
      // to the configured goal execution mode, and starts a turn immediately.
      if (
        selectedBackendRef.current === 'codex' &&
        /^\/goal(\s|$)/.test(textMessage)
      ) {
        const arg = textMessage.replace(/^\/goal\s*/, '').trim()
        const sessionId = activeSessionId
        const worktreeId = activeWorktreeId
        const worktreePath = activeWorktreePath

        if (!arg) {
          clearInputDraft(sessionId)
          clearChatInputState()
          void invoke<string | null>('codex_goal_get', {
            worktreeId,
            worktreePath,
            sessionId,
          })
            .then(goal =>
              toast.message(goal ? `Current goal: ${goal}` : 'No goal set')
            )
            .catch(err => toast.error(`/goal failed: ${err}`))
          return
        }
        if (arg === 'clear') {
          clearInputDraft(sessionId)
          clearChatInputState()
          void invoke('codex_goal_clear', {
            worktreeId,
            worktreePath,
            sessionId,
          }).catch(err => toast.error(`/goal failed: ${err}`))
          return
        }

        // /goal <objective>: persist goal, then start work in the configured
        // mode so the active goal is not left as passive metadata.
        try {
          await invoke('codex_goal_set', {
            worktreeId,
            worktreePath,
            sessionId,
            objective: arg,
          })
        } catch (err) {
          toast.error(`/goal failed: ${err}`)
          return
        }
        const configuredGoalMode = preferences?.codex_goal_execution_mode
        const goalMode: ExecutionMode =
          configuredGoalMode === 'yolo' ? 'yolo' : 'build'
        setExecutionMode(sessionId, goalMode)
        executionModeRef.current = goalMode
        message = `Work toward the active goal:\n\n${arg}`
        startedCodexGoalTurn = true
      }
      if (!startedCodexGoalTurn && textMessage.startsWith('/')) {
        const slashName = textMessage.slice(1).split(/\s/)[0] ?? ''
        const params = textMessage.slice(1 + slashName.length).trim()
        const claudeSkills =
          queryClient.getQueryData<{ name: string }[]>(
            skillQueryKeys.claudeSkills(activeWorktreePath)
          ) ?? []
        const codexSkills =
          queryClient.getQueryData<{ name: string }[]>(
            skillQueryKeys.codexSkills()
          ) ?? []
        const isSkill =
          claudeSkills.some(s => s.name === slashName) ||
          codexSkills.some(s => s.name === slashName)
        if (!isSkill) {
          const claudeCommands =
            queryClient.getQueryData<{ name: string; path: string }[]>(
              skillQueryKeys.claudeCommands(activeWorktreePath)
            ) ?? []
          const cmd = claudeCommands.find(c => c.name === slashName)
          if (cmd) {
            message = `Run the /${slashName} command from ${cmd.path}${params ? ` with arguments: ${params}` : ''}`
          }
        }
      }

      if (
        images.length > 0 ||
        files.length > 0 ||
        textFiles.length > 0 ||
        skills.length > 0
      ) {
        useChatStore.getState().setLastSentAttachments(activeSessionId, {
          images,
          files,
          textFiles,
          skills,
        })
      }

      clearInputDraft(activeSessionId)
      clearPendingImages(activeSessionId)
      clearPendingFiles(activeSessionId)
      clearPendingSkills(activeSessionId)
      clearPendingTextFiles(activeSessionId)
      setSessionReviewing(activeSessionId, false)

      clearChatInputState()

      const { setQuestionsSkipped, setWaitingForInput } =
        useChatStore.getState()
      setQuestionsSkipped(activeSessionId, false)
      setWaitingForInput(activeSessionId, false)

      const mode = executionModeRef.current
      const thinkingLvl = selectedThinkingLevelRef.current
      const queuedMessage: QueuedMessage = {
        id: generateId(),
        message,
        pendingImages: images,
        pendingFiles: files,
        pendingSkills: skills,
        pendingTextFiles: textFiles,
        model: selectedModelRef.current,
        provider: selectedProviderRef.current,
        executionMode: mode,
        thinkingLevel: thinkingLvl,
        effortLevel:
          useAdaptiveThinkingRef.current || isCodexBackendRef.current
            ? selectedEffortLevelRef.current
            : undefined,
        mcpConfig: buildMcpConfigJson(
          mcpServersDataRef.current ?? [],
          enabledMcpServersRef.current,
          selectedBackendRef.current
        ),
        backend:
          selectedBackendRef.current !== 'claude'
            ? selectedBackendRef.current
            : undefined,
        queuedAt: Date.now(),
      }

      markAtBottom()

      const isSendingNow = checkIsSendingNow(activeSessionId)
      console.log(
        `[Send] handleSubmit sessionId=${activeSessionId} isSending=${isSendingNow}`
      )
      if (isSendingNow) {
        console.log(`[Send] handleSubmit ENQUEUING (session is sending)`)
        enqueueMessage(activeSessionId, queuedMessage)
        persistEnqueue(
          activeWorktreeId,
          activeWorktreePath,
          activeSessionId,
          queuedMessage
        )
        return
      }

      sendMessageNow(queuedMessage)
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      clearInputDraft,
      clearChatInputState,
      markAtBottom,
      sendMessageNow,
      sessionsData,
    ]
  )

  // Handle cancellation of running Claude process
  const handleCancel = useCallback(async () => {
    console.log('[Cancel] handleCancel called', {
      activeSessionId,
      activeWorktreeId,
    })
    if (!activeSessionId || !activeWorktreeId) return
    const sending =
      useChatStore.getState().sendingSessionIds[activeSessionId] ?? false
    console.log('[Cancel] sendingSessionIds check', {
      sending,
      allSending: Object.keys(useChatStore.getState().sendingSessionIds),
    })
    if (!sending) return

    const cancelled = await cancelChatMessage(activeSessionId, activeWorktreeId)
    console.log('[Cancel] cancelChatMessage result', { cancelled })
    if (!cancelled) {
      // Race condition: process already completed but chat:done hasn't been processed yet.
      // Force-clear the stale sending state so the UI doesn't stay stuck.
      const store = useChatStore.getState()
      const stillSending = store.sendingSessionIds[activeSessionId] ?? false
      if (stillSending) {
        console.log('[Cancel] Force-clearing stale sending state')
        store.cancelSession(activeSessionId)
        const session = queryClient.getQueryData<Session>(
          chatQueryKeys.session(activeSessionId)
        )
        if (!session || session.messages.length === 0) {
          store.setSessionReviewing(activeSessionId, false)
        }
      }
    }
  }, [activeSessionId, activeWorktreeId, queryClient])

  return {
    resolveCustomProfile,
    sendMessageNow,
    handleSubmit,
    handleCancel,
    handleGitDiffAddToPrompt,
    handleGitDiffExecutePrompt,
  }
}
