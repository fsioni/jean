import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor } from '@testing-library/react'
import { render } from '@/test/test-utils'
import { useProjectsStore } from '@/store/projects-store'
import { JeanConfigWizard } from './JeanConfigWizard'

const saveJeanConfigMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/projects', () => ({
  useProjects: () => ({
    data: [{ id: 'project-1', name: 'Jean', path: '/tmp/jean' }],
  }),
  useSaveJeanConfig: () => ({
    isPending: false,
    mutateAsync: saveJeanConfigMock,
  }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { has_seen_jean_config_wizard: false },
  }),
  usePatchPreferences: () => ({ mutate: vi.fn() }),
}))

describe('JeanConfigWizard mobile layout', () => {
  beforeEach(() => {
    saveJeanConfigMock.mockReset()
    saveJeanConfigMock.mockResolvedValue(undefined)
    useProjectsStore.setState({
      jeanConfigWizardOpen: true,
      jeanConfigWizardProjectId: 'project-1',
    })
  })

  it('keeps the form scrollable and the actions inside the mobile viewport', () => {
    render(<JeanConfigWizard />)

    expect(
      screen.getByRole('dialog', { name: 'Configure Automation' })
    ).toHaveClass(
      '!inset-0',
      '!h-dvh',
      '!max-w-none',
      'flex',
      'overflow-hidden'
    )
    expect(screen.getByTestId('jean-config-wizard-scroll')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
      'overscroll-contain'
    )
    expect(screen.getByTestId('jean-config-wizard-actions')).toHaveClass(
      'shrink-0',
      'pb-[calc(env(safe-area-inset-bottom)+1rem)]'
    )
    expect(screen.getByRole('button', { name: 'Skip' })).toHaveClass('h-11')
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('h-11')
  })

  it('stacks configured port fields within the mobile width', async () => {
    const user = userEvent.setup()
    render(<JeanConfigWizard />)

    await user.click(screen.getByRole('button', { name: 'Add port' }))

    expect(screen.getByTestId('jean-config-wizard-port-fields')).toHaveClass(
      'grid',
      'grid-cols-2',
      'sm:flex'
    )
    expect(screen.getByPlaceholderText('Label')).toHaveClass(
      'col-span-2',
      'sm:w-auto'
    )
  })

  it('saves project run policy and links declared app ports to its range', async () => {
    const user = userEvent.setup()
    render(<JeanConfigWizard />)

    await user.selectOptions(screen.getByLabelText('Concurrency'), 'exclusive')
    await user.selectOptions(screen.getByLabelText('Run ports'), 'workspace')
    await user.clear(screen.getByLabelText('Ports reserved per workspace'))
    await user.type(screen.getByLabelText('Ports reserved per workspace'), '4')
    await user.click(screen.getByRole('button', { name: 'Add port' }))
    await user.type(screen.getByPlaceholderText('Port'), '3000')
    await user.type(screen.getByPlaceholderText('Label'), 'Web App')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(saveJeanConfigMock).toHaveBeenCalledWith({
        projectPath: '/tmp/jean',
        config: {
          scripts: { setup: null, teardown: null, run: null },
          ports: [{ port: 3000, label: 'Web App', host: undefined }],
          runPolicy: {
            mode: 'exclusive',
            portAllocation: 'workspace',
            portsPerWorkspace: 4,
          },
        },
      })
    })
  })
})
