import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const projectsState = {
  selectedProjectId: null as string | null,
  selectedWorktreeId: null as string | null,
}
const chatState = { activeWorktreePath: null as string | null }
const uiState = { missionControlOpen: true }
const setMissionControlOpen = vi.fn((open: boolean) => {
  uiState.missionControlOpen = open
})

// Minimal zustand-like stubs: a selector-taking hook whose value the test drives
// by mutating the plain state objects then re-rendering.
vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (selector: (s: typeof projectsState) => unknown) =>
    selector(projectsState),
}))
vi.mock('@/store/chat-store', () => ({
  useChatStore: (selector: (s: typeof chatState) => unknown) =>
    selector(chatState),
}))
vi.mock('@/store/ui-store', () => ({
  useUIStore: { getState: () => ({ setMissionControlOpen }) },
}))

import { useCloseMissionControlOnNavigate } from './useCloseMissionControlOnNavigate'

beforeEach(() => {
  projectsState.selectedProjectId = null
  projectsState.selectedWorktreeId = null
  chatState.activeWorktreePath = null
  uiState.missionControlOpen = true
  setMissionControlOpen.mockClear()
})

describe('useCloseMissionControlOnNavigate', () => {
  it('does not close on mount, even with a selection already restored', () => {
    projectsState.selectedProjectId = 'p1'
    renderHook(() => useCloseMissionControlOnNavigate())
    expect(setMissionControlOpen).not.toHaveBeenCalled()
  })

  it('closes when a project is selected in the sidebar', () => {
    const { rerender } = renderHook(() => useCloseMissionControlOnNavigate())
    act(() => {
      projectsState.selectedProjectId = 'p1'
    })
    rerender()
    expect(setMissionControlOpen).toHaveBeenCalledWith(false)
  })

  it('closes when a worktree is selected', () => {
    const { rerender } = renderHook(() => useCloseMissionControlOnNavigate())
    act(() => {
      projectsState.selectedWorktreeId = 'w1'
    })
    rerender()
    expect(setMissionControlOpen).toHaveBeenCalledWith(false)
  })

  it('closes when a worktree chat is opened', () => {
    const { rerender } = renderHook(() => useCloseMissionControlOnNavigate())
    act(() => {
      chatState.activeWorktreePath = '/tmp/wt'
    })
    rerender()
    expect(setMissionControlOpen).toHaveBeenCalledWith(false)
  })

  it('stays open while nothing about the navigation target changes', () => {
    const { rerender } = renderHook(() => useCloseMissionControlOnNavigate())
    rerender()
    rerender()
    expect(setMissionControlOpen).not.toHaveBeenCalled()
  })
})
