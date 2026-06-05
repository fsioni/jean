/**
 * Onboarding Dialog for CLI Setup
 *
 * Multi-step wizard that handles installation and authentication of at least
 * one AI backend CLI (Claude/Codex/OpenCode) plus mandatory GitHub CLI.
 */

/* eslint-disable no-console */
const dbg = (...args: unknown[]) => console.debug('[ONBOARDING]', ...args)

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useUIStore } from '@/store/ui-store'
import {
  useClaudeCliSetup,
  useClaudeCliAuth,
  useClaudePathDetection,
} from '@/services/claude-cli'
import {
  useCodexCliSetup,
  useCodexCliAuth,
  useCodexPathDetection,
} from '@/services/codex-cli'
import {
  useOpenCodeCliSetup,
  useOpenCodeCliAuth,
  useOpenCodePathDetection,
} from '@/services/opencode-cli'
import {
  useGhCliSetup,
  useGhCliAuth,
  useGhPathDetection,
} from '@/services/gh-cli'
import {
  SetupState,
  InstallingState,
  ErrorState,
  AuthCheckingState,
  AuthLoginState,
  CliPathSelector,
} from './CliSetupComponents'
import { toast } from 'sonner'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { isWindows } from '@/lib/platform'
import { WslSetupStep } from './WslSetupStep'
import { ArrowLeft } from 'lucide-react'

type AIBackend = 'claude' | 'codex' | 'opencode'
type CliType = AIBackend | 'gh'

const AI_BACKENDS: AIBackend[] = ['claude', 'codex', 'opencode']

type OnboardingStep =
  | 'wsl-setup'
  | 'backend-select'
  | 'claude-setup'
  | 'claude-installing'
  | 'claude-auth-checking'
  | 'claude-auth-login'
  | 'codex-setup'
  | 'codex-installing'
  | 'codex-auth-checking'
  | 'codex-auth-login'
  | 'opencode-setup'
  | 'opencode-installing'
  | 'opencode-auth-checking'
  | 'opencode-auth-login'
  | 'gh-setup'
  | 'gh-installing'
  | 'gh-auth-checking'
  | 'gh-auth-login'
  | 'complete'

/**
 * Steps that represent meaningful user-facing screens. Transitioning AWAY from
 * one of these via setStep() pushes it onto the back-history stack.
 * Transient/auto-advancing steps (*-installing, *-auth-checking) are excluded so
 * they never appear as a Back destination.
 */
const BACK_NAVIGABLE_STEPS: readonly OnboardingStep[] = [
  'wsl-setup',
  'backend-select',
  'claude-setup',
  'codex-setup',
  'opencode-setup',
  'claude-auth-login',
  'codex-auth-login',
  'opencode-auth-login',
  'gh-setup',
  'gh-auth-login',
] as const

interface VersionOption {
  version: string
  prerelease: boolean
  tagName?: string
  tag_name?: string
  publishedAt?: string
  published_at?: string
}

interface CliSetupData {
  type: CliType
  title: string
  description: string
  versions: VersionOption[]
  isVersionsLoading: boolean
  isVersionsError: boolean
  onRetryVersions: () => void
  isInstalling: boolean
  installError: Error | null
  progress: { stage: string; message: string; percent: number } | null
  install: (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => void
  currentVersion: string | null | undefined
}

const backendLabel: Record<CliType, string> = {
  claude: 'Claude CLI',
  codex: 'Codex CLI',
  opencode: 'OpenCode CLI',
  gh: 'GitHub CLI',
}

function stepToBackend(step: OnboardingStep): AIBackend | null {
  if (step.startsWith('claude-')) return 'claude'
  if (step.startsWith('codex-')) return 'codex'
  if (step.startsWith('opencode-')) return 'opencode'
  return null
}

/**
 * Always mounted so Radix Dialog can properly clean up its portal/overlay
 * when closing. Unmounting while open leaves a stale overlay that blocks clicks.
 */
export function OnboardingDialog() {
  return <OnboardingDialogContent />
}

/**
 * Inner component with all hook logic.
 * Only mounted when dialog is actually open.
 */
function OnboardingDialogContent() {
  const {
    onboardingOpen,
    onboardingStartStep,
    setOnboardingStartStep,
    onboardingManuallyTriggered,
  } = useUIStore()

  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  const claudeSetup = useClaudeCliSetup()
  const pathDetection = useClaudePathDetection()
  const codexPathDetection = useCodexPathDetection()
  const opencodePathDetection = useOpenCodePathDetection()
  const codexSetup = useCodexCliSetup()
  const opencodeSetup = useOpenCodeCliSetup()
  const ghPathDetection = useGhPathDetection()
  const ghSetup = useGhCliSetup()

  const claudeAuth = useClaudeCliAuth({
    enabled: !!claudeSetup.status?.installed,
  })
  const codexAuth = useCodexCliAuth({ enabled: !!codexSetup.status?.installed })
  const opencodeAuth = useOpenCodeCliAuth({
    enabled: !!opencodeSetup.status?.installed,
  })
  const ghAuth = useGhCliAuth({ enabled: !!ghSetup.status?.installed })

  const [step, _setStepRaw] = useState<OnboardingStep>('backend-select')
  const stepRef = useRef<OnboardingStep>('backend-select')
  const [historyStack, setHistoryStack] = useState<OnboardingStep[]>([])
  const setStep = useCallback(
    (next: OnboardingStep, opts?: { replace?: boolean }) => {
      const current = stepRef.current
      dbg('step:', current, '→', next, opts?.replace ? '(replace)' : '')
      if (
        !opts?.replace &&
        current !== next &&
        BACK_NAVIGABLE_STEPS.includes(current)
      ) {
        setHistoryStack(h =>
          h[h.length - 1] === current ? h : [...h, current]
        )
      }
      stepRef.current = next
      _setStepRaw(next)
    },
    []
  )
  const [selectedBackends, setSelectedBackends] = useState<AIBackend[]>([])
  const [, setActiveBackendIndex] = useState(0)

  const [claudeVersion, setClaudeVersion] = useState<string | null>(null)
  const [codexVersion, setCodexVersion] = useState<string | null>(null)
  const [opencodeVersion, setOpencodeVersion] = useState<string | null>(null)
  const [ghVersion, setGhVersion] = useState<string | null>(null)

  const [claudeInstallFailed, setClaudeInstallFailed] = useState(false)
  const [codexInstallFailed, setCodexInstallFailed] = useState(false)
  const [opencodeInstallFailed, setOpencodeInstallFailed] = useState(false)
  const [ghInstallFailed, setGhInstallFailed] = useState(false)
  const [claudePathSelected, setClaudePathSelected] = useState(false)
  const [codexPathSelected, setCodexPathSelected] = useState(false)
  const [opencodePathSelected, setOpencodePathSelected] = useState(false)
  const [ghPathSelected, setGhPathSelected] = useState(false)
  const [claudeLoginAttempt, setClaudeLoginAttempt] = useState(0)
  const [codexLoginAttempt, setCodexLoginAttempt] = useState(0)
  const [opencodeLoginAttempt, setOpencodeLoginAttempt] = useState(0)
  const [ghLoginAttempt, setGhLoginAttempt] = useState(0)

  const goBack = useCallback(() => {
    const current = stepRef.current
    // Sub-state back-out: on a *-setup step, the source picker and the
    // version installer are both rendered — "Back" from the installer should
    // first return to the picker, not pop step history.
    if (current === 'claude-setup' && claudePathSelected) {
      dbg('step: BACK (sub-state) claude-setup installer → picker')
      setClaudePathSelected(false)
      setClaudeInstallFailed(false)
      return
    }
    if (current === 'codex-setup' && codexPathSelected) {
      dbg('step: BACK (sub-state) codex-setup installer → picker')
      setCodexPathSelected(false)
      setCodexInstallFailed(false)
      return
    }
    if (current === 'opencode-setup' && opencodePathSelected) {
      dbg('step: BACK (sub-state) opencode-setup installer → picker')
      setOpencodePathSelected(false)
      setOpencodeInstallFailed(false)
      return
    }
    if (current === 'gh-setup' && ghPathSelected) {
      dbg('step: BACK (sub-state) gh-setup installer → picker')
      setGhPathSelected(false)
      setGhInstallFailed(false)
      return
    }

    setHistoryStack(h => {
      const prev = h.at(-1)
      if (!prev) return h
      dbg('step: BACK', stepRef.current, '→', prev)
      // Reset transient per-CLI state so the user lands on a fresh screen
      // (re-shows the path/Jean-managed picker, clears any prior install error).
      if (prev === 'claude-setup') {
        setClaudePathSelected(false)
        setClaudeInstallFailed(false)
      } else if (prev === 'codex-setup') {
        setCodexPathSelected(false)
        setCodexInstallFailed(false)
      } else if (prev === 'opencode-setup') {
        setOpencodePathSelected(false)
        setOpencodeInstallFailed(false)
      } else if (prev === 'gh-setup') {
        setGhPathSelected(false)
        setGhInstallFailed(false)
      }
      stepRef.current = prev
      _setStepRaw(prev)
      return h.slice(0, -1)
    })
  }, [
    claudePathSelected,
    codexPathSelected,
    opencodePathSelected,
    ghPathSelected,
  ])

  const isTransientStep =
    step.endsWith('-installing') || step.endsWith('-auth-checking')
  const hasSubStateBack =
    (step === 'claude-setup' && claudePathSelected) ||
    (step === 'codex-setup' && codexPathSelected) ||
    (step === 'opencode-setup' && opencodePathSelected) ||
    (step === 'gh-setup' && ghPathSelected)
  const canGoBack =
    (historyStack.length > 0 || hasSubStateBack) &&
    step !== 'complete' &&
    !isTransientStep

  const initializedFlowRef = useRef(false)

  // Seed for terminal IDs - each retry increments an attempt counter to force a fresh PTY
  const loginSessionSeed = useMemo(
    // eslint-disable-next-line react-hooks/purity
    () => Date.now(),
    []
  )
  const claudeLoginTerminalId = `onboarding-claude-login-${loginSessionSeed}-${claudeLoginAttempt}`
  const codexLoginTerminalId = `onboarding-codex-login-${loginSessionSeed}-${codexLoginAttempt}`
  const opencodeLoginTerminalId = `onboarding-opencode-login-${loginSessionSeed}-${opencodeLoginAttempt}`
  const ghLoginTerminalId = `onboarding-gh-login-${loginSessionSeed}-${ghLoginAttempt}`

  const stableClaudeVersions = claudeSetup.versions.filter(v => !v.prerelease)
  const stableCodexVersions = codexSetup.versions.filter(v => !v.prerelease)
  const stableOpencodeVersions = opencodeSetup.versions.filter(
    v => !v.prerelease
  )
  const stableGhVersions = ghSetup.versions.filter(v => !v.prerelease)

  useEffect(() => {
    if (!claudeVersion && stableClaudeVersions.length > 0) {
      queueMicrotask(() =>
        setClaudeVersion(stableClaudeVersions[0]?.version ?? null)
      )
    }
  }, [claudeVersion, stableClaudeVersions])

  useEffect(() => {
    if (!codexVersion && stableCodexVersions.length > 0) {
      queueMicrotask(() =>
        setCodexVersion(stableCodexVersions[0]?.version ?? null)
      )
    }
  }, [codexVersion, stableCodexVersions])

  useEffect(() => {
    if (!opencodeVersion && stableOpencodeVersions.length > 0) {
      queueMicrotask(() =>
        setOpencodeVersion(stableOpencodeVersions[0]?.version ?? null)
      )
    }
  }, [opencodeVersion, stableOpencodeVersions])

  useEffect(() => {
    if (!ghVersion && stableGhVersions.length > 0) {
      queueMicrotask(() => setGhVersion(stableGhVersions[0]?.version ?? null))
    }
  }, [ghVersion, stableGhVersions])

  const isBackendReady = useCallback(
    (backend: AIBackend) => {
      let ready = false
      if (backend === 'claude') {
        ready =
          !!claudeSetup.status?.installed && !!claudeAuth.data?.authenticated
      } else if (backend === 'codex') {
        ready =
          !!codexSetup.status?.installed && !!codexAuth.data?.authenticated
      } else {
        ready =
          !!opencodeSetup.status?.installed &&
          !!opencodeAuth.data?.authenticated
      }
      dbg('isBackendReady:', backend, '→', ready)
      return ready
    },
    [
      claudeSetup.status?.installed,
      claudeAuth.data?.authenticated,
      codexSetup.status?.installed,
      codexAuth.data?.authenticated,
      opencodeSetup.status?.installed,
      opencodeAuth.data?.authenticated,
    ]
  )

  const getNextStepForBackend = useCallback(
    (backend: AIBackend): OnboardingStep => {
      // Always route user through the *-setup step so they can confirm/change
      // the source (Jean-managed vs system PATH) and version. The picker
      // auto-advances to auth-checking when the user picks an already-ready
      // configuration, so this adds no friction for the happy path.
      const result = `${backend}-setup` as OnboardingStep
      dbg('getNextStepForBackend:', backend, '→', result)
      return result
    },
    []
  )

  const getNextStepAfterBackends = useCallback((): OnboardingStep => {
    // Always show gh-setup so the user can confirm source + auth.
    return 'gh-setup'
  }, [])

  const moveToNextBackendOrGh = useCallback(
    (currentBackend: AIBackend) => {
      dbg(
        'moveToNextBackendOrGh:',
        currentBackend,
        'selectedBackends:',
        selectedBackends
      )
      const currentIndex = selectedBackends.indexOf(currentBackend)
      for (let i = currentIndex + 1; i < selectedBackends.length; i += 1) {
        const backend = selectedBackends[i]
        if (!backend) continue
        const nextStep = getNextStepForBackend(backend)
        if (nextStep) {
          dbg(
            'moveToNextBackendOrGh: next backend =',
            backend,
            'step =',
            nextStep
          )
          setActiveBackendIndex(i)
          setStep(nextStep)
          return
        }
      }

      const afterBackends = getNextStepAfterBackends()
      dbg('moveToNextBackendOrGh: all backends done, next =', afterBackends)
      setStep(afterBackends)
    },
    [selectedBackends, getNextStepForBackend, getNextStepAfterBackends]
  )

  const loadingInitialState =
    claudeSetup.isStatusLoading ||
    codexSetup.isStatusLoading ||
    opencodeSetup.isStatusLoading ||
    ghSetup.isStatusLoading ||
    (claudeSetup.status?.installed &&
      (claudeAuth.isLoading || claudeAuth.isFetching)) ||
    (codexSetup.status?.installed &&
      (codexAuth.isLoading || codexAuth.isFetching)) ||
    (opencodeSetup.status?.installed &&
      (opencodeAuth.isLoading || opencodeAuth.isFetching)) ||
    (ghSetup.status?.installed && (ghAuth.isLoading || ghAuth.isFetching))

  dbg('loadingInitialState:', loadingInitialState, {
    claudeStatusLoading: claudeSetup.isStatusLoading,
    codexStatusLoading: codexSetup.isStatusLoading,
    opencodeStatusLoading: opencodeSetup.isStatusLoading,
    ghStatusLoading: ghSetup.isStatusLoading,
    claudeInstalled: claudeSetup.status?.installed,
    codexInstalled: codexSetup.status?.installed,
    opencodeInstalled: opencodeSetup.status?.installed,
    ghInstalled: ghSetup.status?.installed,
    claudeAuthLoading: claudeAuth.isLoading,
    codexAuthLoading: codexAuth.isLoading,
    opencodeAuthLoading: opencodeAuth.isLoading,
    ghAuthLoading: ghAuth.isLoading,
  })

  useEffect(() => {
    if (!onboardingOpen) {
      initializedFlowRef.current = false
      setHistoryStack([])
      return
    }

    if (loadingInitialState || initializedFlowRef.current || !preferences) {
      dbg(
        'init effect: skipped (loading:',
        loadingInitialState,
        'initialized:',
        initializedFlowRef.current,
        ')'
      )
      return
    }

    dbg('init effect: INITIALIZING FLOW')
    initializedFlowRef.current = true

    queueMicrotask(() => {
      setClaudeInstallFailed(false)
      setCodexInstallFailed(false)
      setOpencodeInstallFailed(false)
      setGhInstallFailed(false)
      setClaudePathSelected(false)
      setCodexPathSelected(false)
      setOpencodePathSelected(false)
      setGhPathSelected(false)
      setClaudeLoginAttempt(0)
      setCodexLoginAttempt(0)
      setOpencodeLoginAttempt(0)
      setGhLoginAttempt(0)
    })

    // On Windows, show WSL mode selection first if not yet chosen
    if (
      isWindows &&
      preferences &&
      !preferences.wsl_mode_chosen &&
      !onboardingStartStep
    ) {
      dbg('init effect: Windows + WSL not chosen → wsl-setup')
      queueMicrotask(() => setStep('wsl-setup', { replace: true }))
      return
    }

    if (onboardingStartStep === 'gh') {
      dbg('init effect: startStep=gh → gh-setup')
      queueMicrotask(() => {
        setStep('gh-setup', { replace: true })
        setOnboardingStartStep(null)
      })
      return
    }

    if (onboardingStartStep === 'claude') {
      dbg('init effect: startStep=claude → claude-setup')
      queueMicrotask(() => {
        setSelectedBackends(['claude'])
        setActiveBackendIndex(0)
        setStep('claude-setup', { replace: true })
        setOnboardingStartStep(null)
      })
      return
    }

    const readyBackends = AI_BACKENDS.filter(isBackendReady)
    const ghReady = !!ghSetup.status?.installed && !!ghAuth.data?.authenticated
    dbg(
      'init effect: readyBackends:',
      readyBackends,
      'ghReady:',
      ghReady,
      'manuallyTriggered:',
      onboardingManuallyTriggered
    )

    // When manually triggered, always start at wsl-setup on Windows so users
    // can change their WSL/native choice, then backend-select (via Continue
    // on the WSL step). Non-Windows goes straight to backend-select.
    if (onboardingManuallyTriggered) {
      const firstStep: OnboardingStep = isWindows
        ? 'wsl-setup'
        : 'backend-select'
      dbg('init effect: manual trigger →', firstStep)
      queueMicrotask(() => setStep(firstStep, { replace: true }))
      return
    }

    if (ghReady && readyBackends.length > 0) {
      dbg('init effect: all ready → complete')
      queueMicrotask(() => setStep('complete', { replace: true }))
      return
    }

    if (readyBackends.length > 0) {
      dbg('init effect: some backends ready → skip to after backends')
      queueMicrotask(() => {
        setSelectedBackends(readyBackends)
        setStep(getNextStepAfterBackends(), { replace: true })
      })
      return
    }

    dbg('init effect: nothing ready → backend-select')
    queueMicrotask(() => setStep('backend-select', { replace: true }))
  }, [
    onboardingOpen,
    onboardingStartStep,
    setOnboardingStartStep,
    onboardingManuallyTriggered,
    loadingInitialState,
    isBackendReady,
    ghSetup.status?.installed,
    ghAuth.data?.authenticated,
    getNextStepAfterBackends,
    preferences,
  ])

  // Handle AI backend auth check steps
  useEffect(() => {
    if (step !== 'claude-auth-checking') return
    dbg('claude-auth-checking effect:', {
      isLoading: claudeAuth.isLoading,
      isFetching: claudeAuth.isFetching,
      status: claudeAuth.status,
      fetchStatus: claudeAuth.fetchStatus,
      authenticated: claudeAuth.data?.authenticated,
      error: claudeAuth.error,
      enabled: !!claudeSetup.status?.installed,
    })
    if (claudeAuth.isLoading || claudeAuth.isFetching) return

    if (claudeAuth.data?.authenticated) {
      dbg('claude auth OK → moveToNextBackendOrGh')
      queueMicrotask(() => moveToNextBackendOrGh('claude'))
    } else {
      dbg('claude auth NOT OK → claude-auth-login')
      queueMicrotask(() => setStep('claude-auth-login'))
    }
  }, [
    step,
    claudeAuth.isLoading,
    claudeAuth.isFetching,
    claudeAuth.data?.authenticated,
    claudeAuth.status,
    claudeAuth.fetchStatus,
    claudeAuth.error,
    claudeSetup.status?.installed,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'codex-auth-checking') return
    dbg('codex-auth-checking effect:', {
      isLoading: codexAuth.isLoading,
      isFetching: codexAuth.isFetching,
      status: codexAuth.status,
      fetchStatus: codexAuth.fetchStatus,
      authenticated: codexAuth.data?.authenticated,
      error: codexAuth.error,
      enabled: !!codexSetup.status?.installed,
    })
    if (codexAuth.isLoading || codexAuth.isFetching) return

    if (codexAuth.data?.authenticated) {
      dbg('codex auth OK → moveToNextBackendOrGh')
      queueMicrotask(() => moveToNextBackendOrGh('codex'))
    } else {
      dbg('codex auth NOT OK → codex-auth-login')
      queueMicrotask(() => setStep('codex-auth-login'))
    }
  }, [
    step,
    codexAuth.isLoading,
    codexAuth.isFetching,
    codexAuth.data?.authenticated,
    codexAuth.status,
    codexAuth.fetchStatus,
    codexAuth.error,
    codexSetup.status?.installed,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'opencode-auth-checking') return
    dbg('opencode-auth-checking effect:', {
      isLoading: opencodeAuth.isLoading,
      isFetching: opencodeAuth.isFetching,
      status: opencodeAuth.status,
      fetchStatus: opencodeAuth.fetchStatus,
      authenticated: opencodeAuth.data?.authenticated,
      error: opencodeAuth.error,
      enabled: !!opencodeSetup.status?.installed,
    })
    if (opencodeAuth.isLoading || opencodeAuth.isFetching) return

    if (opencodeAuth.data?.authenticated) {
      dbg('opencode auth OK → moveToNextBackendOrGh')
      queueMicrotask(() => moveToNextBackendOrGh('opencode'))
    } else {
      dbg('opencode auth NOT OK → opencode-auth-login')
      queueMicrotask(() => setStep('opencode-auth-login'))
    }
  }, [
    step,
    opencodeAuth.isLoading,
    opencodeAuth.isFetching,
    opencodeAuth.data?.authenticated,
    opencodeAuth.status,
    opencodeAuth.fetchStatus,
    opencodeAuth.error,
    opencodeSetup.status?.installed,
    moveToNextBackendOrGh,
    setStep,
  ])

  useEffect(() => {
    if (step !== 'gh-auth-checking') return
    dbg('gh-auth-checking effect:', {
      isLoading: ghAuth.isLoading,
      isFetching: ghAuth.isFetching,
      status: ghAuth.status,
      fetchStatus: ghAuth.fetchStatus,
      authenticated: ghAuth.data?.authenticated,
      error: ghAuth.error,
      enabled: !!ghSetup.status?.installed,
    })
    if (ghAuth.isLoading || ghAuth.isFetching) return

    if (ghAuth.data?.authenticated) {
      dbg('gh auth OK → complete')
      queueMicrotask(() => setStep('complete'))
    } else {
      dbg('gh auth NOT OK → gh-auth-login')
      queueMicrotask(() => setStep('gh-auth-login'))
    }
  }, [
    step,
    ghAuth.isLoading,
    ghAuth.isFetching,
    ghAuth.data?.authenticated,
    ghAuth.status,
    ghAuth.fetchStatus,
    ghAuth.error,
    ghSetup.status?.installed,
    setStep,
  ])

  const handleBackendToggle = useCallback(
    (backend: AIBackend, checked: boolean) => {
      setSelectedBackends(prev => {
        if (checked) {
          if (prev.includes(backend)) return prev
          return [...prev, backend]
        }
        return prev.filter(b => b !== backend)
      })
    },
    []
  )

  const handleBackendSelectionContinue = useCallback(() => {
    dbg('handleBackendSelectionContinue: selectedBackends =', selectedBackends)
    if (selectedBackends.length === 0 && !onboardingManuallyTriggered) {
      toast.warning('Select at least one AI backend to continue.')
      return
    }

    for (let i = 0; i < selectedBackends.length; i += 1) {
      const backend = selectedBackends[i]
      if (!backend) continue
      const nextStep = getNextStepForBackend(backend)
      if (nextStep) {
        dbg(
          'handleBackendSelectionContinue: first backend =',
          backend,
          'step =',
          nextStep
        )
        setActiveBackendIndex(i)
        setStep(nextStep)
        return
      }
    }

    const afterBackends = getNextStepAfterBackends()
    dbg(
      'handleBackendSelectionContinue: all backends ready, next =',
      afterBackends
    )
    setStep(afterBackends)
  }, [
    selectedBackends,
    onboardingManuallyTriggered,
    getNextStepForBackend,
    getNextStepAfterBackends,
  ])

  const handleClaudeInstall = useCallback(() => {
    dbg('handleClaudeInstall: version =', claudeVersion)
    if (!claudeVersion) return
    setStep('claude-installing')
    claudeSetup.install(claudeVersion, {
      onSuccess: () => {
        dbg('handleClaudeInstall: SUCCESS, moving to auth-checking')
        setStep('claude-auth-checking')
        claudeAuth.refetch()
      },
      onError: () => {
        dbg('handleClaudeInstall: FAILED')
        setClaudeInstallFailed(true)
        setStep('claude-setup')
      },
    })
  }, [claudeVersion, claudeSetup, claudeAuth])

  const handleClaudeJeanSelect = useCallback(() => {
    dbg('handleClaudeJeanSelect: saving claude_cli_source=jean')
    setClaudePathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { claude_cli_source: 'jean' },
      {
        onSuccess: () => {
          // If Claude is already installed via Jean, skip the reinstall step
          // and jump straight to authentication.
          if (claudeSetup.status?.installed) {
            setStep('claude-auth-checking')
            claudeAuth.refetch()
          }
          // Otherwise the conditional in the JSX falls through to SetupState
          // (the version installer) since claudePathSelected is now true.
        },
        onError: err => {
          dbg('handleClaudeJeanSelect: FAILED to save preference', err)
          setClaudePathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    claudeSetup.status?.installed,
    claudeAuth,
    setStep,
  ])

  const handleClaudePathSelect = useCallback(() => {
    dbg('handleClaudePathSelect: saving claude_cli_source=path')
    setClaudePathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { claude_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg('handleClaudePathSelect: preference saved, refetching auth')
            setStep('claude-auth-checking')
            claudeAuth.refetch()
          },
          onError: err => {
            dbg('handleClaudePathSelect: FAILED to save preference', err)
            setClaudePathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, claudeAuth, setStep])

  const handleCodexJeanSelect = useCallback(() => {
    dbg('handleCodexJeanSelect: saving codex_cli_source=jean')
    setCodexPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { codex_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (codexSetup.status?.installed) {
            setStep('codex-auth-checking')
            codexAuth.refetch()
          }
        },
        onError: err => {
          dbg('handleCodexJeanSelect: FAILED to save preference', err)
          setCodexPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    codexSetup.status?.installed,
    codexAuth,
    setStep,
  ])

  const handleOpencodeJeanSelect = useCallback(() => {
    dbg('handleOpencodeJeanSelect: saving opencode_cli_source=jean')
    setOpencodePathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { opencode_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (opencodeSetup.status?.installed) {
            setStep('opencode-auth-checking')
            opencodeAuth.refetch()
          }
        },
        onError: err => {
          dbg('handleOpencodeJeanSelect: FAILED to save preference', err)
          setOpencodePathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    opencodeSetup.status?.installed,
    opencodeAuth,
    setStep,
  ])

  const handleGhJeanSelect = useCallback(() => {
    dbg('handleGhJeanSelect: saving gh_cli_source=jean')
    setGhPathSelected(true)
    if (!preferences) return
    patchPreferences.mutate(
      { gh_cli_source: 'jean' },
      {
        onSuccess: () => {
          if (ghSetup.status?.installed) {
            setStep('gh-auth-checking')
            ghAuth.refetch()
          }
        },
        onError: err => {
          dbg('handleGhJeanSelect: FAILED to save preference', err)
          setGhPathSelected(false)
          toast.error('Failed to save CLI source preference')
        },
      }
    )
  }, [
    preferences,
    patchPreferences,
    ghSetup.status?.installed,
    ghAuth,
    setStep,
  ])

  const handleCodexPathSelect = useCallback(() => {
    dbg('handleCodexPathSelect: saving codex_cli_source=path')
    setCodexPathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { codex_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg('handleCodexPathSelect: preference saved, refetching auth')
            setStep('codex-auth-checking')
            codexAuth.refetch()
          },
          onError: err => {
            dbg('handleCodexPathSelect: FAILED to save preference', err)
            setCodexPathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, codexAuth, setStep])

  const handleOpencodePathSelect = useCallback(() => {
    dbg('handleOpencodePathSelect: saving opencode_cli_source=path')
    setOpencodePathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { opencode_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg('handleOpencodePathSelect: preference saved, refetching auth')
            setStep('opencode-auth-checking')
            opencodeAuth.refetch()
          },
          onError: err => {
            dbg('handleOpencodePathSelect: FAILED to save preference', err)
            setOpencodePathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, opencodeAuth, setStep])

  const handleGhPathSelect = useCallback(() => {
    dbg('handleGhPathSelect: saving gh_cli_source=path')
    setGhPathSelected(true)
    if (preferences) {
      patchPreferences.mutate(
        { gh_cli_source: 'path' },
        {
          onSuccess: () => {
            dbg('handleGhPathSelect: preference saved, refetching auth')
            setStep('gh-auth-checking')
            ghAuth.refetch()
          },
          onError: err => {
            dbg('handleGhPathSelect: FAILED to save preference', err)
            setGhPathSelected(false)
            toast.error('Failed to save CLI source preference')
          },
        }
      )
    }
  }, [preferences, patchPreferences, ghAuth, setStep])

  const handleCodexInstall = useCallback(() => {
    dbg('handleCodexInstall: version =', codexVersion)
    if (!codexVersion) return
    setStep('codex-installing')
    codexSetup.install(codexVersion, {
      onSuccess: () => {
        dbg('handleCodexInstall: SUCCESS, moving to auth-checking')
        setStep('codex-auth-checking')
        codexAuth.refetch()
      },
      onError: () => {
        dbg('handleCodexInstall: FAILED')
        setCodexInstallFailed(true)
        setStep('codex-setup')
      },
    })
  }, [codexVersion, codexSetup, codexAuth])

  const handleOpencodeInstall = useCallback(() => {
    dbg('handleOpencodeInstall: version =', opencodeVersion)
    if (!opencodeVersion) return
    setStep('opencode-installing')
    opencodeSetup.install(opencodeVersion, {
      onSuccess: () => {
        dbg('handleOpencodeInstall: SUCCESS, moving to auth-checking')
        setStep('opencode-auth-checking')
        opencodeAuth.refetch()
      },
      onError: () => {
        dbg('handleOpencodeInstall: FAILED')
        setOpencodeInstallFailed(true)
        setStep('opencode-setup')
      },
    })
  }, [opencodeVersion, opencodeSetup, opencodeAuth])

  const handleGhInstall = useCallback(() => {
    dbg('handleGhInstall: version =', ghVersion)
    if (!ghVersion) return
    setStep('gh-installing')
    ghSetup.install(ghVersion, {
      onSuccess: () => {
        dbg('handleGhInstall: SUCCESS, moving to auth-checking')
        setStep('gh-auth-checking')
        ghAuth.refetch()
      },
      onError: () => {
        dbg('handleGhInstall: FAILED')
        setGhInstallFailed(true)
        setStep('gh-setup')
      },
    })
  }, [ghVersion, ghSetup, ghAuth])

  const handleClaudeLoginComplete = useCallback(async () => {
    dbg('handleClaudeLoginComplete: refetching auth')
    setStep('claude-auth-checking')
    const result = await claudeAuth.refetch()
    dbg('handleClaudeLoginComplete: refetch result =', result.data)
  }, [claudeAuth, setStep])

  const handleCodexLoginComplete = useCallback(async () => {
    dbg('handleCodexLoginComplete: refetching auth')
    setStep('codex-auth-checking')
    const result = await codexAuth.refetch()
    dbg('handleCodexLoginComplete: refetch result =', result.data)
  }, [codexAuth, setStep])

  const handleOpencodeLoginComplete = useCallback(async () => {
    dbg('handleOpencodeLoginComplete: refetching auth')
    setStep('opencode-auth-checking')
    const result = await opencodeAuth.refetch()
    dbg('handleOpencodeLoginComplete: refetch result =', result.data)
  }, [opencodeAuth, setStep])

  const handleGhLoginComplete = useCallback(async () => {
    dbg('handleGhLoginComplete: refetching auth')
    setStep('gh-auth-checking')
    const result = await ghAuth.refetch()
    dbg('handleGhLoginComplete: refetch result =', result.data)
  }, [ghAuth, setStep])

  const handleClaudeLoginRetry = useCallback(() => {
    setClaudeLoginAttempt(prev => prev + 1)
  }, [])

  const handleCodexLoginRetry = useCallback(() => {
    setCodexLoginAttempt(prev => prev + 1)
  }, [])

  const handleOpencodeLoginRetry = useCallback(() => {
    setOpencodeLoginAttempt(prev => prev + 1)
  }, [])

  const handleGhLoginRetry = useCallback(() => {
    setGhLoginAttempt(prev => prev + 1)
  }, [])

  const handleComplete = useCallback(() => {
    claudeSetup.refetchStatus()
    codexSetup.refetchStatus()
    opencodeSetup.refetchStatus()
    ghSetup.refetchStatus()
    // Set the first selected backend as the default so the preference
    // isn't left pointing at an uninstalled backend (e.g. 'claude').
    const [firstBackend] = selectedBackends
    if (firstBackend && preferences) {
      patchPreferences.mutate({ default_backend: firstBackend })
    }
    // Atomically close onboarding and mark as dismissed so it doesn't reappear on reload
    useUIStore.setState({
      onboardingOpen: false,
      onboardingStartStep: null,
      onboardingDismissed: true,
    })
  }, [
    claudeSetup,
    codexSetup,
    opencodeSetup,
    ghSetup,
    selectedBackends,
    preferences,
    patchPreferences,
  ])

  const handleAbort = useCallback(() => {
    // Atomic update: onboardingDismissed must be true BEFORE onboardingOpen
    // becomes false, otherwise the App.tsx subscriber sees dismissed=false
    // and incorrectly opens the feature tour dialog.
    useUIStore.setState({
      onboardingOpen: false,
      onboardingStartStep: null,
      onboardingDismissed: true,
    })
    // Safety: Radix Dialog sometimes fails to restore pointer-events on <body>
    setTimeout(() => {
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.removeProperty('pointer-events')
      }
    }, 500)
  }, [])

  const getCliSetupData = (): CliSetupData | null => {
    if (step === 'claude-setup' || step === 'claude-installing') {
      return {
        type: 'claude',
        title: 'Claude CLI',
        description: 'Claude CLI enables Anthropic-backed AI sessions.',
        versions: stableClaudeVersions,
        isVersionsLoading: claudeSetup.isVersionsLoading,
        isVersionsError: claudeSetup.isVersionsError,
        onRetryVersions: claudeSetup.refetchVersions,
        isInstalling: claudeSetup.isInstalling,
        installError: claudeInstallFailed ? claudeSetup.installError : null,
        progress: claudeSetup.progress,
        install: claudeSetup.install,
        currentVersion: claudeSetup.status?.version,
      }
    }

    if (step === 'codex-setup' || step === 'codex-installing') {
      return {
        type: 'codex',
        title: 'Codex CLI',
        description: 'Codex CLI enables OpenAI-backed AI sessions.',
        versions: stableCodexVersions,
        isVersionsLoading: codexSetup.isVersionsLoading,
        isVersionsError: codexSetup.isVersionsError,
        onRetryVersions: codexSetup.refetchVersions,
        isInstalling: codexSetup.isInstalling,
        installError: codexInstallFailed ? codexSetup.installError : null,
        progress: codexSetup.progress,
        install: codexSetup.install,
        currentVersion: codexSetup.status?.version,
      }
    }

    if (step === 'opencode-setup' || step === 'opencode-installing') {
      return {
        type: 'opencode',
        title: 'OpenCode CLI',
        description: 'OpenCode CLI enables OpenCode-backed AI sessions.',
        versions: stableOpencodeVersions,
        isVersionsLoading: opencodeSetup.isVersionsLoading,
        isVersionsError: opencodeSetup.isVersionsError,
        onRetryVersions: opencodeSetup.refetchVersions,
        isInstalling: opencodeSetup.isInstalling,
        installError: opencodeInstallFailed ? opencodeSetup.installError : null,
        progress: opencodeSetup.progress,
        install: opencodeSetup.install,
        currentVersion: opencodeSetup.status?.version,
      }
    }

    if (step === 'gh-setup' || step === 'gh-installing') {
      return {
        type: 'gh',
        title: 'GitHub CLI',
        description: 'GitHub CLI is required for GitHub integration.',
        versions: stableGhVersions,
        isVersionsLoading: ghSetup.isVersionsLoading,
        isVersionsError: ghSetup.isVersionsError,
        onRetryVersions: ghSetup.refetchVersions,
        isInstalling: ghSetup.isInstalling,
        installError: ghInstallFailed ? ghSetup.installError : null,
        progress: ghSetup.progress,
        install: ghSetup.install,
        currentVersion: ghSetup.status?.version,
      }
    }

    return null
  }

  const cliData = getCliSetupData()

  const isClaudeReinstall =
    claudeSetup.status?.installed && step === 'claude-setup'
  const isCodexReinstall =
    codexSetup.status?.installed && step === 'codex-setup'
  const isOpencodeReinstall =
    opencodeSetup.status?.installed && step === 'opencode-setup'
  const isGhReinstall = ghSetup.status?.installed && step === 'gh-setup'

  // When CLI source is 'path', use the path detection result for login command
  // (the Jean-managed status.path may be empty if Jean hasn't installed the CLI)
  const claudeLoginCommand =
    claudePathSelected && pathDetection.data?.path
      ? pathDetection.data.path
      : (claudeSetup.status?.path ?? '')
  const claudeLoginArgs = claudeSetup.status?.supports_auth_command
    ? ['auth', 'login']
    : ['login']
  const codexLoginCommand =
    codexPathSelected && codexPathDetection.data?.path
      ? codexPathDetection.data.path
      : (codexSetup.status?.path ?? '')
  const codexLoginArgs = ['login']
  const opencodeLoginCommand =
    opencodePathSelected && opencodePathDetection.data?.path
      ? opencodePathDetection.data.path
      : (opencodeSetup.status?.path ?? '')
  const opencodeLoginArgs = ['auth', 'login']
  const ghLoginCommand =
    ghPathSelected && ghPathDetection.data?.path
      ? ghPathDetection.data.path
      : (ghSetup.status?.path ?? '')
  const ghLoginArgs = ['auth', 'login']

  dbg('login commands:', {
    claude: {
      cmd: claudeLoginCommand,
      args: claudeLoginArgs,
      path: claudeSetup.status?.path,
      pathSelected: claudePathSelected,
      detectedPath: pathDetection.data?.path,
    },
    codex: {
      cmd: codexLoginCommand,
      args: codexLoginArgs,
      path: codexSetup.status?.path,
      pathSelected: codexPathSelected,
      detectedPath: codexPathDetection.data?.path,
    },
    opencode: {
      cmd: opencodeLoginCommand,
      args: opencodeLoginArgs,
      path: opencodeSetup.status?.path,
      pathSelected: opencodePathSelected,
      detectedPath: opencodePathDetection.data?.path,
    },
    gh: {
      cmd: ghLoginCommand,
      args: ghLoginArgs,
      path: ghSetup.status?.path,
      pathSelected: ghPathSelected,
      detectedPath: ghPathDetection.data?.path,
    },
  })

  const getDialogContent = () => {
    if (step === 'wsl-setup') {
      return {
        title: 'Welcome to Jean',
        description: 'Choose your development environment.',
      }
    }

    if (step === 'backend-select') {
      return {
        title: onboardingManuallyTriggered
          ? 'Install AI Backends'
          : 'Welcome to Jean',
        description: onboardingManuallyTriggered
          ? 'Select additional AI backends to install.'
          : 'Select at least one AI backend to install. GitHub CLI setup is required next.',
      }
    }

    if (step === 'complete') {
      return {
        title: 'Setup Complete',
        description:
          'All required tools have been installed and authenticated.',
      }
    }

    if (step === 'gh-setup' || step === 'gh-installing') {
      const hasPathCli = ghPathDetection.data?.found
      return {
        title: isGhReinstall ? 'Change GitHub CLI Version' : 'Setup GitHub CLI',
        description: isGhReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : hasPathCli
            ? 'Choose to use your system GitHub CLI or install with Jean.'
            : 'GitHub CLI is required for GitHub integration.',
      }
    }

    if (step === 'gh-auth-checking' || step === 'gh-auth-login') {
      return {
        title: 'Authenticate GitHub CLI',
        description: 'GitHub CLI authentication is required to continue.',
      }
    }

    const currentBackend = stepToBackend(step)
    const backendName = currentBackend
      ? backendLabel[currentBackend]
      : 'AI Backend'

    if (step === 'claude-setup' || step === 'claude-installing') {
      const isReinstall = isClaudeReinstall

      return {
        title: isReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : pathDetection.data?.found
            ? 'Choose to use your system Claude or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (step === 'codex-setup' || step === 'codex-installing') {
      const isReinstall = isCodexReinstall
      const hasPathCli = codexPathDetection.data?.found

      return {
        title: isReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : hasPathCli
            ? 'Choose to use your system Codex or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (step === 'opencode-setup' || step === 'opencode-installing') {
      const isReinstall = isOpencodeReinstall
      const hasPathCli = opencodePathDetection.data?.found

      return {
        title: isReinstall
          ? `Change ${backendName} Version`
          : `Setup ${backendName}`,
        description: isReinstall
          ? 'Select a version to install. This will replace the current installation.'
          : hasPathCli
            ? 'Choose to use your system OpenCode or install with Jean.'
            : 'Select a version to install.',
      }
    }

    if (
      step === 'claude-auth-checking' ||
      step === 'claude-auth-login' ||
      step === 'codex-auth-checking' ||
      step === 'codex-auth-login' ||
      step === 'opencode-auth-checking' ||
      step === 'opencode-auth-login'
    ) {
      return {
        title: `Authenticate ${backendName}`,
        description: `${backendName} requires authentication to function.`,
      }
    }

    return { title: 'Setup', description: '' }
  }

  const dialogContent = getDialogContent()

  const renderStepIndicator = () => {
    const isBackendSelection = step === 'backend-select'
    const isBackendStep =
      step.startsWith('claude-') ||
      step.startsWith('codex-') ||
      step.startsWith('opencode-')
    const isGhStep = step.startsWith('gh-')

    const backendComplete = !isBackendSelection && !isBackendStep
    const ghComplete = step === 'complete'

    return (
      <div className="flex items-center justify-center gap-2 mb-4">
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            isBackendSelection || isBackendStep
              ? 'bg-primary text-primary-foreground'
              : backendComplete
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          <span className="font-medium">1</span>
          <span>AI Backend(s)</span>
        </div>
        <div className="w-4 h-px bg-border" />
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            isGhStep
              ? 'bg-primary text-primary-foreground'
              : ghComplete
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          <span className="font-medium">2</span>
          <span>GitHub CLI</span>
        </div>
        <div className="w-4 h-px bg-border" />
        <div
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            step === 'complete'
              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          <span className="font-medium">3</span>
          <span>Done</span>
        </div>
      </div>
    )
  }

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (step === 'complete') {
          handleComplete()
        } else {
          handleAbort()
        }
      }
    },
    [step, handleComplete, handleAbort]
  )

  return (
    <Dialog open={onboardingOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] flex flex-col"
        preventClose
      >
        <DialogHeader>
          <DialogTitle className="text-xl">{dialogContent.title}</DialogTitle>
          <DialogDescription>{dialogContent.description}</DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto py-4 flex flex-col">
          {step !== 'wsl-setup' && renderStepIndicator()}

          <div className="w-full">
            {step === 'wsl-setup' ? (
              <WslSetupStep
                onComplete={() => {
                  dbg('WSL setup complete → backend-select')
                  setStep('backend-select')
                }}
              />
            ) : step === 'backend-select' ? (
              <BackendSelectionState
                selectedBackends={selectedBackends}
                onToggle={handleBackendToggle}
                onContinue={handleBackendSelectionContinue}
                readyBackends={
                  onboardingManuallyTriggered
                    ? AI_BACKENDS.filter(isBackendReady)
                    : []
                }
              />
            ) : step === 'complete' ? (
              <SuccessState
                claudeVersion={claudeSetup.status?.version}
                codexVersion={codexSetup.status?.version}
                opencodeVersion={opencodeSetup.status?.version}
                ghVersion={ghSetup.status?.version}
                onContinue={handleComplete}
              />
            ) : step === 'claude-installing' && cliData ? (
              <InstallingState
                cliName="Claude CLI"
                progress={cliData.progress}
              />
            ) : step === 'codex-installing' && cliData ? (
              <InstallingState
                cliName="Codex CLI"
                progress={cliData.progress}
              />
            ) : step === 'opencode-installing' && cliData ? (
              <InstallingState
                cliName="OpenCode CLI"
                progress={cliData.progress}
              />
            ) : step === 'gh-installing' && cliData ? (
              <InstallingState
                cliName="GitHub CLI"
                progress={cliData.progress}
              />
            ) : step === 'claude-auth-checking' ? (
              <AuthCheckingState cliName="Claude CLI" />
            ) : step === 'codex-auth-checking' ? (
              <AuthCheckingState cliName="Codex CLI" />
            ) : step === 'opencode-auth-checking' ? (
              <AuthCheckingState cliName="OpenCode CLI" />
            ) : step === 'gh-auth-checking' ? (
              <AuthCheckingState cliName="GitHub CLI" />
            ) : step === 'claude-setup' && !claudePathSelected ? (
              <CliPathSelector
                cliName="Claude CLI"
                pathFound={!!pathDetection.data?.found}
                pathVersion={pathDetection.data?.version ?? null}
                pathPath={pathDetection.data?.path ?? null}
                isLoading={claudePathSelected}
                currentSource={preferences?.claude_cli_source ?? null}
                jeanInstalled={!!claudeSetup.status?.installed}
                onSelectPath={handleClaudePathSelect}
                onSelectJean={handleClaudeJeanSelect}
              />
            ) : step === 'codex-setup' && !codexPathSelected ? (
              <CliPathSelector
                cliName="Codex CLI"
                pathFound={!!codexPathDetection.data?.found}
                pathVersion={codexPathDetection.data?.version ?? null}
                pathPath={codexPathDetection.data?.path ?? null}
                isLoading={codexPathSelected}
                currentSource={preferences?.codex_cli_source ?? null}
                jeanInstalled={!!codexSetup.status?.installed}
                onSelectPath={handleCodexPathSelect}
                onSelectJean={handleCodexJeanSelect}
              />
            ) : step === 'opencode-setup' && !opencodePathSelected ? (
              <CliPathSelector
                cliName="OpenCode CLI"
                pathFound={!!opencodePathDetection.data?.found}
                pathVersion={opencodePathDetection.data?.version ?? null}
                pathPath={opencodePathDetection.data?.path ?? null}
                isLoading={opencodePathSelected}
                currentSource={preferences?.opencode_cli_source ?? null}
                jeanInstalled={!!opencodeSetup.status?.installed}
                onSelectPath={handleOpencodePathSelect}
                onSelectJean={handleOpencodeJeanSelect}
              />
            ) : step === 'claude-auth-login' ? (
              claudeLoginCommand ? (
                <AuthLoginState
                  key={claudeLoginTerminalId}
                  cliName="Claude CLI"
                  terminalId={claudeLoginTerminalId}
                  command={claudeLoginCommand}
                  commandArgs={claudeLoginArgs}
                  onComplete={handleClaudeLoginComplete}
                  onRetry={handleClaudeLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="Claude CLI" />
              )
            ) : step === 'codex-auth-login' ? (
              codexLoginCommand ? (
                <AuthLoginState
                  key={codexLoginTerminalId}
                  cliName="Codex CLI"
                  terminalId={codexLoginTerminalId}
                  command={codexLoginCommand}
                  commandArgs={codexLoginArgs}
                  onComplete={handleCodexLoginComplete}
                  onRetry={handleCodexLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="Codex CLI" />
              )
            ) : step === 'opencode-auth-login' ? (
              opencodeLoginCommand ? (
                <AuthLoginState
                  key={opencodeLoginTerminalId}
                  cliName="OpenCode CLI"
                  terminalId={opencodeLoginTerminalId}
                  command={opencodeLoginCommand}
                  commandArgs={opencodeLoginArgs}
                  onComplete={handleOpencodeLoginComplete}
                  onRetry={handleOpencodeLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="OpenCode CLI" />
              )
            ) : step === 'gh-setup' && !ghPathSelected ? (
              <CliPathSelector
                cliName="GitHub CLI"
                pathFound={!!ghPathDetection.data?.found}
                pathVersion={ghPathDetection.data?.version ?? null}
                pathPath={ghPathDetection.data?.path ?? null}
                isLoading={ghPathSelected}
                currentSource={preferences?.gh_cli_source ?? null}
                jeanInstalled={!!ghSetup.status?.installed}
                onSelectPath={handleGhPathSelect}
                onSelectJean={handleGhJeanSelect}
              />
            ) : step === 'gh-auth-login' ? (
              ghLoginCommand ? (
                <AuthLoginState
                  key={ghLoginTerminalId}
                  cliName="GitHub CLI"
                  terminalId={ghLoginTerminalId}
                  command={ghLoginCommand}
                  commandArgs={ghLoginArgs}
                  onComplete={handleGhLoginComplete}
                  onRetry={handleGhLoginRetry}
                />
              ) : (
                <AuthCheckingState cliName="GitHub CLI" />
              )
            ) : cliData ? (
              cliData.installError ? (
                <ErrorState
                  cliName={backendLabel[cliData.type]}
                  error={cliData.installError}
                  onRetry={
                    cliData.type === 'claude'
                      ? handleClaudeInstall
                      : cliData.type === 'codex'
                        ? handleCodexInstall
                        : cliData.type === 'opencode'
                          ? handleOpencodeInstall
                          : handleGhInstall
                  }
                />
              ) : (
                <SetupState
                  cliName={backendLabel[cliData.type]}
                  versions={cliData.versions}
                  selectedVersion={
                    cliData.type === 'claude'
                      ? claudeVersion
                      : cliData.type === 'codex'
                        ? codexVersion
                        : cliData.type === 'opencode'
                          ? opencodeVersion
                          : ghVersion
                  }
                  currentVersion={
                    (cliData.type === 'claude' && isClaudeReinstall) ||
                    (cliData.type === 'codex' && isCodexReinstall) ||
                    (cliData.type === 'opencode' && isOpencodeReinstall) ||
                    (cliData.type === 'gh' && isGhReinstall)
                      ? cliData.currentVersion
                      : null
                  }
                  isLoading={cliData.isVersionsLoading}
                  isError={cliData.isVersionsError}
                  onRetry={cliData.onRetryVersions}
                  onVersionChange={
                    cliData.type === 'claude'
                      ? setClaudeVersion
                      : cliData.type === 'codex'
                        ? setCodexVersion
                        : cliData.type === 'opencode'
                          ? setOpencodeVersion
                          : setGhVersion
                  }
                  onInstall={
                    cliData.type === 'claude'
                      ? handleClaudeInstall
                      : cliData.type === 'codex'
                        ? handleCodexInstall
                        : cliData.type === 'opencode'
                          ? handleOpencodeInstall
                          : handleGhInstall
                  }
                />
              )
            ) : (
              <BackendSelectionState
                selectedBackends={selectedBackends}
                onToggle={handleBackendToggle}
                onContinue={handleBackendSelectionContinue}
              />
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-3 mt-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={goBack}
            disabled={!canGoBack}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <span className="text-xs text-muted-foreground">
            {isTransientStep ? 'Working...' : ''}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface BackendSelectionStateProps {
  selectedBackends: AIBackend[]
  onToggle: (backend: AIBackend, checked: boolean) => void
  onContinue: () => void
  readyBackends?: AIBackend[]
}

function BackendSelectionState({
  selectedBackends,
  onToggle,
  onContinue,
  readyBackends = [],
}: BackendSelectionStateProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {AI_BACKENDS.map(backend => {
          const id = `backend-${backend}`
          const checked = selectedBackends.includes(backend)
          const label = backendLabel[backend]
          const isReady = readyBackends.includes(backend)

          return (
            <label
              key={backend}
              htmlFor={id}
              className="flex items-center gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-accent/40"
            >
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={value => onToggle(backend, value === true)}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{label}</p>
                  {isReady && (
                    <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                      installed
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {isReady
                    ? `Reconfigure ${label} (change source or version).`
                    : `Install and authenticate ${label}.`}
                </p>
              </div>
            </label>
          )
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        You must have at least one AI backend installed. Selecting an installed
        backend lets you switch between Jean-managed and system PATH or change
        versions.
      </p>

      <Button onClick={onContinue} className="w-full" size="lg">
        Continue
      </Button>
    </div>
  )
}

interface SuccessStateProps {
  claudeVersion: string | null | undefined
  codexVersion: string | null | undefined
  opencodeVersion: string | null | undefined
  ghVersion: string | null | undefined
  onContinue: () => void
}

function SuccessState({
  claudeVersion,
  codexVersion,
  opencodeVersion,
  ghVersion,
  onContinue,
}: SuccessStateProps) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="font-medium">All Tools Ready</p>
        <div className="text-sm text-muted-foreground mt-2 space-y-1">
          {claudeVersion && <p>Claude CLI: v{claudeVersion}</p>}
          {codexVersion && <p>Codex CLI: v{codexVersion}</p>}
          {opencodeVersion && <p>OpenCode CLI: v{opencodeVersion}</p>}
          {ghVersion && <p>GitHub CLI: v{ghVersion}</p>}
          {!claudeVersion &&
            !codexVersion &&
            !opencodeVersion &&
            !ghVersion && <p>Setup complete</p>}
        </div>
      </div>

      <Button onClick={onContinue} className="w-full" size="lg">
        Continue to Jean
      </Button>
    </div>
  )
}

export default OnboardingDialog
