import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TOAST_ACTION_SHORTCUT,
  ToastActionLabel,
} from '@/lib/toast-action-label'

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal()),
  isNativeApp: () =>
    (globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean })
      .__JEAN_TEST_IS_NATIVE__ ?? true,
}))

describe('ToastActionLabel', () => {
  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = true
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    })
  })

  it('renders the action text with the universal toast action shortcut on native desktop', () => {
    render(<ToastActionLabel>Resolve Conflicts</ToastActionLabel>)

    expect(screen.getByText('Resolve Conflicts')).toBeInTheDocument()
    expect(screen.getByText(TOAST_ACTION_SHORTCUT.label)).toBeInTheDocument()
  })

  it('hides the shortcut hint in web access', () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = false

    render(<ToastActionLabel>Resolve Conflicts</ToastActionLabel>)

    expect(screen.getByText('Resolve Conflicts')).toBeInTheDocument()
    expect(
      screen.queryByText(TOAST_ACTION_SHORTCUT.label)
    ).not.toBeInTheDocument()
  })

  it('hides the shortcut hint on mobile width', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    })

    render(<ToastActionLabel>Resolve Conflicts</ToastActionLabel>)

    expect(screen.getByText('Resolve Conflicts')).toBeInTheDocument()
    expect(
      screen.queryByText(TOAST_ACTION_SHORTCUT.label)
    ).not.toBeInTheDocument()
  })
})
