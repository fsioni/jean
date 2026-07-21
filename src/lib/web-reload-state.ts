const STORAGE_KEY = 'jean:web-reload-state'
const MAX_AGE_MS = 60_000

export interface WebReloadState {
  projectId: string
  modalWorktreeId: string
  modalWorktreePath: string
  activeSessionId: string
}

interface StoredWebReloadState extends WebReloadState {
  savedAt: number
}

function clearWebReloadState(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function saveWebReloadState(state: WebReloadState): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, savedAt: Date.now() })
    )
  } catch {
    // Recovery state is best-effort and must never block the reload.
  }
}

export function peekWebReloadState(): WebReloadState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as Partial<StoredWebReloadState>
    const {
      projectId,
      modalWorktreeId,
      modalWorktreePath,
      activeSessionId,
      savedAt,
    } = stored
    if (
      typeof projectId !== 'string' ||
      typeof modalWorktreeId !== 'string' ||
      typeof modalWorktreePath !== 'string' ||
      typeof activeSessionId !== 'string' ||
      typeof savedAt !== 'number' ||
      Date.now() - savedAt > MAX_AGE_MS
    ) {
      clearWebReloadState()
      return null
    }

    return {
      projectId,
      modalWorktreeId,
      modalWorktreePath,
      activeSessionId,
    }
  } catch {
    clearWebReloadState()
    return null
  }
}

export function consumeWebReloadState(
  projectId: string
): WebReloadState | null {
  const state = peekWebReloadState()
  if (!state || state.projectId !== projectId) return null
  clearWebReloadState()
  return state
}
