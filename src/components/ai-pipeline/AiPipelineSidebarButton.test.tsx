import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { MobileLeftSidebar } from '@/components/layout/MobileLeftSidebar'
import { AiPipelineSidebarButton } from './AiPipelineSidebarButton'
import { AiPipelinePrModal } from './AiPipelinePrModal'

let isMobile = true
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile }))
vi.mock('@/services/ai-pipeline', () => ({
  useHasAiPipelineAccess: () => true,
  useAiPipelineProjectId: () => ({
    projectId: 'pinned-project',
    isPinned: true,
  }),
  useFinishAiPipelinePr: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/services/clickup', () => ({
  useResolvedClickUpTaskId: () => ({ data: undefined }),
}))
vi.mock('./AiPipelineTaskList', () => ({
  AiPipelineTaskList: () => <button>Reprendre un ticket</button>,
}))
vi.mock('./AiPipelineProjectPicker', () => ({
  AiPipelineProjectPicker: () => null,
}))
vi.mock('./AiPipelineValidationPanel', () => ({
  AiPipelineValidationPanel: () => null,
}))
vi.mock('@/components/layout/LeftSideBar', () => ({
  LeftSideBar: () => <AiPipelineSidebarButton isNarrow={false} />,
}))

function MobileHarness() {
  const open = useUIStore(state => state.leftSidebarVisible)
  return (
    <>
      <MobileLeftSidebar
        open={open}
        onOpenChange={useUIStore.getState().setLeftSidebarVisible}
      />
      <AiPipelinePrModal />
    </>
  )
}

describe('Pipeline entry', () => {
  beforeEach(() => {
    isMobile = true
    useUIStore.setState({
      leftSidebarVisible: true,
      aiPipelineModalOpen: false,
      aiPipelineModalProjectId: null,
    })
  })

  it('hands off the mobile drawer to an interactive pipeline dialog', async () => {
    render(<MobileHarness />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pipeline IA' }))
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
    expect(useUIStore.getState().aiPipelineModalProjectId).toBe(
      'pinned-project'
    )
    expect(screen.queryByTestId('mobile-left-sidebar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre un ticket' }))
    expect(useUIStore.getState().aiPipelineModalOpen).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useUIStore.getState().aiPipelineModalOpen).toBe(false)
  })

  it('keeps the desktop sidebar visible when opening the pipeline', () => {
    isMobile = false
    render(<AiPipelineSidebarButton isNarrow={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline IA' }))
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
    expect(useUIStore.getState().aiPipelineModalOpen).toBe(true)
  })
})
