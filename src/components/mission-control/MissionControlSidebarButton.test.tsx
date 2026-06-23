import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

const mockRows = vi.fn<() => { failureCount: number }>()
const mockSetOpen = vi.fn()

vi.mock('./useMissionControlRows', () => ({
  useMissionControlRows: () => mockRows(),
}))
vi.mock('@/store/ui-store', () => {
  const useUIStore = (
    selector: (s: { missionControlOpen: boolean }) => unknown
  ) => selector({ missionControlOpen: false })
  useUIStore.getState = () => ({ setMissionControlOpen: mockSetOpen })
  return { useUIStore }
})

import { MissionControlSidebarButton } from './MissionControlSidebarButton'

beforeEach(() => {
  mockRows.mockReset()
  mockSetOpen.mockReset()
})

describe('MissionControlSidebarButton', () => {
  it('renders the label when the sidebar is wide', () => {
    mockRows.mockReturnValue({ failureCount: 0 })
    const { getByText } = render(
      <MissionControlSidebarButton isNarrow={false} />
    )
    expect(getByText('Mission Control')).toBeInTheDocument()
  })

  it('shows an icon + number counter (not color alone) when pipelines fail', () => {
    mockRows.mockReturnValue({ failureCount: 3 })
    const { getByText, getByTitle } = render(
      <MissionControlSidebarButton isNarrow={false} />
    )
    expect(getByText('3')).toBeInTheDocument()
    // Tooltip text spells out the meaning beyond the red color.
    expect(getByTitle('3 pipelines en échec')).toBeInTheDocument()
  })

  it('hides the counter when nothing is failing', () => {
    mockRows.mockReturnValue({ failureCount: 0 })
    const { queryByText } = render(
      <MissionControlSidebarButton isNarrow={false} />
    )
    expect(queryByText('0')).toBeNull()
  })

  it('opens Mission Control on click', () => {
    mockRows.mockReturnValue({ failureCount: 1 })
    const { getByLabelText } = render(
      <MissionControlSidebarButton isNarrow={false} />
    )
    fireEvent.click(getByLabelText('Mission Control'))
    expect(mockSetOpen).toHaveBeenCalledWith(true)
  })

  it('hides the text label in narrow mode but keeps the button reachable', () => {
    mockRows.mockReturnValue({ failureCount: 0 })
    const { queryByText, getByLabelText } = render(
      <MissionControlSidebarButton isNarrow={true} />
    )
    expect(queryByText('Mission Control')).toBeNull()
    expect(getByLabelText('Mission Control')).toBeInTheDocument()
  })
})
