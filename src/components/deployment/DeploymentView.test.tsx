import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { DeploymentView } from './DeploymentView'

let hasAccess = true
vi.mock('@/services/ai-pipeline', () => ({
  useAiPipelineProjectId: () => ({
    projectId: 'pinned-project',
    project: { name: 'Project' },
  }),
  useHasAiPipelineAccess: () => hasAccess,
}))
vi.mock('@/services/deployment', () => ({
  useDeploymentOverview: () => ({
    data: undefined,
    isLoading: true,
    refetch: vi.fn(),
  }),
  useCloseDeployedTask: () => ({ mutate: vi.fn() }),
  useCloseAllDeployedTasks: () => ({ mutate: vi.fn() }),
}))

describe('Deployment pipeline entry', () => {
  beforeEach(() => {
    hasAccess = true
    useUIStore.setState({
      aiPipelineModalOpen: false,
      aiPipelineModalProjectId: null,
    })
  })

  it('opens the pipeline for the same pinned project without leaving deployment', () => {
    useUIStore.setState({ deploymentOpen: true })
    render(<DeploymentView />)
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline IA' }))
    expect(useUIStore.getState().aiPipelineModalOpen).toBe(true)
    expect(useUIStore.getState().aiPipelineModalProjectId).toBe(
      'pinned-project'
    )
    expect(useUIStore.getState().deploymentOpen).toBe(true)
  })
  it('hides the entry when ClickUp access is unavailable', () => {
    hasAccess = false
    render(<DeploymentView />)
    expect(
      screen.queryByRole('button', { name: 'Pipeline IA' })
    ).not.toBeInTheDocument()
  })
})
