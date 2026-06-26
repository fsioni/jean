import { defineConfig } from '@playwright/test'

import e2eConfig from './e2e/playwright.config'

/**
 * Root-level Playwright config so `bunx playwright test e2e/tests/...` works
 * without passing `--config`. It reuses the real config in `e2e/` and only
 * remaps `testDir` to be relative to the repo root.
 */
export default defineConfig({
  ...e2eConfig,
  testDir: './e2e/tests',
})
