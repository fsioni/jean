import { test, expect } from '../fixtures/tauri-mock'
import { project, worktree1 } from '../fixtures/invoke-handlers'

/**
 * End-to-end coverage for the "lost session on web refresh" bug.
 *
 * The frontend race that was fixed: TerminalView used to auto-create a
 * default shell on mount before `useUIStatePersistence` finished hydrating
 * from `ui_state.json`. That spawned a phantom PTY on the backend, which
 * then got overwritten when restore completed — leaving an orphan shell
 * in `TERMINAL_SESSIONS` and a visible flash that looked like "my terminal
 * disappeared".
 *
 * These tests exercise the full mount → restore → auto-create sequence in
 * a real Chromium browser via Playwright and assert on the rendered tab
 * count. The critical regression guard: after refresh, no extra
 * default-labeled ("Shell") tab appears when the persisted state already
 * has live terminals.
 */

const PERSISTED_TERM_LABELS = {
  shell: 'MyShell',
  dev: 'MyDev',
}

function buildUiStateWithLiveTerminals(): Record<string, unknown> {
  const worktreeId = worktree1.id
  return {
    version: 1,
    active_project_id: project.id,
    active_worktree_id: worktreeId,
    active_worktree_path: worktree1.path,
    expanded_project_ids: [project.id],
    project_canvas_settings: {
      [project.id]: { worktree_sort_mode: 'manual' },
    },
    terminal_instances: {
      [worktreeId]: [
        {
          id: 'live-term-shell',
          command: null,
          command_args: null,
          label: PERSISTED_TERM_LABELS.shell,
          kind: 'panel',
        },
        {
          id: 'live-term-dev',
          command: 'pnpm dev',
          command_args: null,
          label: PERSISTED_TERM_LABELS.dev,
          kind: 'panel',
        },
      ],
    },
    terminal_active_ids: { [worktreeId]: 'live-term-shell' },
    terminal_panel_open: { [worktreeId]: true },
    terminal_visible: true,
    terminal_height: 30,
  }
}

/**
 * Terminal-related mock handlers. `load_ui_state` is supplied per-test
 * via the `uiState` parameter; everything else is the same.
 */
const TERMINAL_HANDLER_SCRIPT = `
  mock.invokeHandlers['get_active_terminals'] = () => liveIds
  mock.invokeHandlers['has_active_terminal'] = () => true
  mock.invokeHandlers['terminal_resize'] = () => null
  mock.invokeHandlers['terminal_write'] = () => null
  mock.invokeHandlers['stop_terminal'] = () => true
  mock.invokeHandlers['start_terminal'] = () => null
`

test.describe('Terminal session persistence on web refresh', () => {
  test('restores persisted panel terminals across refresh — no phantom shell', async ({
    mockPage,
  }) => {
    // Seed: 2 live PTYs whose IDs match what's in ui_state.terminal_instances.
    await mockPage.addInitScript(
      ({ uiState, liveIds }) => {
        const mock = (window as any).__JEAN_E2E_MOCK__
        if (!mock) return
        mock.invokeHandlers['load_ui_state'] = () => uiState
        // Inject terminal-related handlers.
        mock.invokeHandlers['get_active_terminals'] = () => liveIds
        mock.invokeHandlers['has_active_terminal'] = () => true
        mock.invokeHandlers['terminal_resize'] = () => null
        mock.invokeHandlers['terminal_write'] = () => null
        mock.invokeHandlers['stop_terminal'] = () => true
        mock.invokeHandlers['start_terminal'] = () => null
      },
      {
        uiState: buildUiStateWithLiveTerminals(),
        liveIds: ['live-term-shell', 'live-term-dev'],
      }
    )

    // Re-navigate so our init script runs.
    await mockPage.goto('/')

    // Wait for the persisted tabs to render.
    const shellTab = mockPage
      .locator('button')
      .filter({ hasText: PERSISTED_TERM_LABELS.shell })
    const devTab = mockPage
      .locator('button')
      .filter({ hasText: PERSISTED_TERM_LABELS.dev })

    await expect(shellTab).toHaveCount(1, { timeout: 10_000 })
    await expect(devTab).toHaveCount(1, { timeout: 10_000 })

    // REGRESSION GUARD: no extra default-labeled "Shell" tab from the
    // pre-hydration auto-create race. The persisted labels are
    // "MyShell"/"MyDev" — different from the auto-create default "Shell".
    // Match "Shell" but exclude buttons that also contain "MyShell".
    const defaultShellTab = mockPage
      .locator('button')
      .filter({ hasText: 'Shell' })
      .filter({ hasNotText: PERSISTED_TERM_LABELS.shell })
    await expect(defaultShellTab).toHaveCount(0, { timeout: 3_000 })

    // Now simulate a refresh: reload the page. addInitScripts re-run.
    await mockPage.reload()

    // After reload, the persisted terminals should still be the only ones
    // and labels should be intact — no third "Shell" tab appeared.
    await expect(shellTab).toHaveCount(1, { timeout: 10_000 })
    await expect(devTab).toHaveCount(1, { timeout: 10_000 })
    await expect(defaultShellTab).toHaveCount(0, { timeout: 3_000 })
  })

  test('after refresh, no phantom start_terminal is invoked for a phantom id', async ({
    mockPage,
  }) => {
    // Track all start_terminal invocations. The regression we're guarding
    // against is: TerminalView auto-creates a shell BEFORE the persisted
    // terminals arrive in the store, causing start_terminal to fire for
    // a phantom id. With the fix, the first start_terminal call must be
    // either (a) for a persisted id or (b) not at all (because all
    // persisted ids are still live and we replay instead of re-spawn).
    const startCalls: Array<Record<string, unknown>> = []

    await mockPage.addInitScript(
      ({ uiState, liveIds }) => {
        const mock = (window as any).__JEAN_E2E_MOCK__
        if (!mock) return
        mock.invokeHandlers['load_ui_state'] = () => uiState
        mock.invokeHandlers['get_active_terminals'] = () => liveIds
        mock.invokeHandlers['has_active_terminal'] = (args: any) => {
          // Only return true for the live IDs. This makes the frontend
          // call `requestTerminalReplay` (not `start_terminal`) for the
          // persisted terminals.
          const tid = args?.terminalId
          return liveIds.includes(tid)
        }
        mock.invokeHandlers['terminal_resize'] = () => null
        mock.invokeHandlers['terminal_write'] = () => null
        mock.invokeHandlers['stop_terminal'] = () => true
        mock.invokeHandlers['start_terminal'] = (args: any) => {
          // eslint-disable-next-line no-console
          ;(window as any).__START_CALLS__ =
            (window as any).__START_CALLS__ ?? []
          ;(window as any).__START_CALLS__.push(args ?? {})
          return null
        }
      },
      {
        uiState: buildUiStateWithLiveTerminals(),
        liveIds: ['live-term-shell', 'live-term-dev'],
      }
    )

    await mockPage.goto('/')

    // Wait for tabs to render — proves hydration completed.
    await expect(
      mockPage
        .locator('button')
        .filter({ hasText: PERSISTED_TERM_LABELS.shell })
    ).toHaveCount(1, { timeout: 10_000 })

    // Inspect start_terminal calls. There must be ZERO phantom ids.
    // The persisted IDs ('live-term-shell', 'live-term-dev') are still
    // live, so the frontend should call requestTerminalReplay instead
    // of start_terminal.
    const calls = await mockPage.evaluate(() => {
      return (window as any).__START_CALLS__ ?? []
    })

    expect(calls).toEqual([])
  })

  test('dead-PTY branch: stale terminal labels are gone after refresh', async ({
    mockPage,
  }) => {
    // Same ui_state as the live case, but the backend reports zero live
    // PTYs (e.g. http_server was restarted between sessions).
    await mockPage.addInitScript(
      ({ uiState }) => {
        const mock = (window as any).__JEAN_E2E_MOCK__
        if (!mock) return
        mock.invokeHandlers['load_ui_state'] = () => uiState
        // Backend has no surviving PTYs.
        mock.invokeHandlers['get_active_terminals'] = () => []
        mock.invokeHandlers['has_active_terminal'] = () => false
        mock.invokeHandlers['start_terminal'] = () => null
        mock.invokeHandlers['terminal_resize'] = () => null
        mock.invokeHandlers['terminal_write'] = () => null
        mock.invokeHandlers['stop_terminal'] = () => true
      },
      { uiState: buildUiStateWithLiveTerminals() }
    )

    await mockPage.goto('/')

    // Wait for chat UI to mount.
    await expect(mockPage.getByText('Claude').first()).toBeVisible({
      timeout: 10_000,
    })

    // The persisted terminal labels (MyShell, MyDev) must NOT appear in
    // the DOM anywhere — the dead-PTY branch clears them from the store
    // and TerminalView's auto-create won't re-spawn them.
    await expect(
      mockPage
        .locator('button')
        .filter({ hasText: PERSISTED_TERM_LABELS.shell })
    ).toHaveCount(0, { timeout: 5_000 })
    await expect(
      mockPage.locator('button').filter({ hasText: PERSISTED_TERM_LABELS.dev })
    ).toHaveCount(0, { timeout: 5_000 })

    // Reload — same invariant must hold (no orphan terminal labels
    // leaked from a previous mount).
    await mockPage.reload()
    await expect(mockPage.getByText('Claude').first()).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      mockPage
        .locator('button')
        .filter({ hasText: PERSISTED_TERM_LABELS.shell })
    ).toHaveCount(0, { timeout: 5_000 })
    await expect(
      mockPage.locator('button').filter({ hasText: PERSISTED_TERM_LABELS.dev })
    ).toHaveCount(0, { timeout: 5_000 })
  })

  test('terminal_panel_open + terminal_visible restore across refresh even when no instances are persisted', async ({
    mockPage,
  }) => {
    // No terminal_instances, but ui_state records the user had the
    // terminal panel open. After the split-restore refactor, these UI
    // flags must persist across refresh and re-open the panel.
    await mockPage.addInitScript(
      ({ uiState }) => {
        const mock = (window as any).__JEAN_E2E_MOCK__
        if (!mock) return
        mock.invokeHandlers['load_ui_state'] = () => uiState
        mock.invokeHandlers['get_active_terminals'] = () => []
        mock.invokeHandlers['has_active_terminal'] = () => false
        mock.invokeHandlers['start_terminal'] = () => null
        mock.invokeHandlers['terminal_resize'] = () => null
        mock.invokeHandlers['terminal_write'] = () => null
        mock.invokeHandlers['stop_terminal'] = () => true
      },
      {
        uiState: {
          version: 1,
          active_project_id: project.id,
          active_worktree_id: worktree1.id,
          active_worktree_path: worktree1.path,
          expanded_project_ids: [project.id],
          project_canvas_settings: {
            [project.id]: { worktree_sort_mode: 'manual' },
          },
          // No terminal_instances. Panel was open + visible per user
          // intent. These flags must restore.
          terminal_panel_open: { [worktree1.id]: true },
          terminal_visible: true,
        },
      }
    )

    await mockPage.goto('/')

    // Wait for chat UI to mount.
    await expect(mockPage.getByText('Claude').first()).toBeVisible({
      timeout: 10_000,
    })

    // The terminal panel is open. TerminalView's auto-create effect
    // (gated on uiStateInitialized) fires and creates a default shell.
    // The "New terminal" tab-bar button proves the panel is expanded
    // and the tab bar is rendered.
    await expect(
      mockPage.getByRole('button', { name: 'New terminal' })
    ).toBeVisible({ timeout: 10_000 })

    // The auto-created default shell tab exists in the DOM.
    const defaultShell = mockPage.locator('button').filter({ hasText: 'Shell' })
    await expect(defaultShell.first()).toBeVisible({ timeout: 10_000 })

    // Reload — same invariant must hold.
    await mockPage.reload()
    await expect(mockPage.getByText('Claude').first()).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      mockPage.getByRole('button', { name: 'New terminal' })
    ).toBeVisible({ timeout: 10_000 })
    await expect(defaultShell.first()).toBeVisible({ timeout: 10_000 })
  })
})
