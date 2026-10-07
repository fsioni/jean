import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'

const setAiPipelineModalOpen = vi.fn()
let projectId: string | null = 'project-1'

vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(
    (selector: (state: { aiPipelineModalOpen: boolean }) => unknown) =>
      selector({ aiPipelineModalOpen: false }),
    { getState: () => ({ setAiPipelineModalOpen }) }
  ),
}))

vi.mock('@/services/ai-pipeline', () => ({
  useHasAiPipelineAccess: () => false,
  useAiPipelineProjectId: () => ({ projectId }),
}))

import { AiPipelineSidebarButton } from './AiPipelineSidebarButton'

describe('AiPipelineSidebarButton', () => {
  beforeEach(() => {
    setAiPipelineModalOpen.mockReset()
    projectId = 'project-1'
  })

  it('remains accessible without ClickUp configuration and opens the project', () => {
    render(<AiPipelineSidebarButton isNarrow={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline IA' }))
    expect(setAiPipelineModalOpen).toHaveBeenCalledWith(true, 'project-1')
  })

  it('opens configuration and the lab without a selected project', () => {
    projectId = null
    render(<AiPipelineSidebarButton isNarrow={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline IA' }))
    expect(setAiPipelineModalOpen).toHaveBeenCalledWith(true, undefined)
  })

  it('keeps an accessible button in the collapsed sidebar', () => {
    render(
      <TooltipProvider>
        <AiPipelineSidebarButton isNarrow />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline IA' }))
    expect(setAiPipelineModalOpen).toHaveBeenCalledWith(true, 'project-1')
  })
})
