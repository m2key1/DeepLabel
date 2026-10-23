import { defineConfig } from '@playwright/test'
import { FRONTEND } from './helpers/frontend'

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // The stack has one shared job queue and one database, so scenarios run serially.
  workers: 1,
  fullyParallel: false,
  // One retry absorbs infra flakes; the first attempt's trace is still saved and
  // the report marks the test as flaky, so real instability stays visible.
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: FRONTEND,
    storageState: '.auth/state.json',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO ?? 0) },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    // Firefox draws text differently enough to break it where Chromium does not (#20), so
    // the specs about how text is drawn run in it too.
    { name: 'firefox', use: { browserName: 'firefox' }, testMatch: /composed-text\.spec\.ts/ },
  ],
})
