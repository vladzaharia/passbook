import { defineConfig, devices } from '@playwright/test';
import { e2ePorts } from './tools/lib/e2e-ports.ts';

const port = e2ePorts.web;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // No retries anywhere: a flake is a bug to fix, not to mask.
  retries: 0,
  // A sign-in may wait out RL_LOGIN's 60 s window (helpers/auth.ts polls up to 70 s), so the test
  // must outlive that wait; the 30 s default failed whenever a run's sign-ins bunched up.
  timeout: 90_000,
  // Playwright empties its outputDir when a run starts. A shared one let a second run in this checkout
  // delete a live run's traces and artifacts (ENOENT); the slot's port is unique per live run.
  outputDir: `test-results/pw-${port}`,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  // Reduced motion: no view transitions or entrance animations, so clicks never land mid-transition.
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'e2e',
      // Camera and wallet specs need their own servers (playwright.camera.config.ts, playwright.wallets.config.ts).
      testIgnore:
        /auth\.setup\.ts|17-scan-camera\.spec|18-scan-native-camera\.spec\.ts|\d+-wallets-[\w-]+\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Local D1 + mock OIDC provider (test/mock-oidc/server.ts) are started by tools/e2e-server.ts.
  webServer: {
    command: 'node tools/e2e-server.ts',
    url: `http://localhost:${port}/health`,
    reuseExistingServer: !process.env.CI,
    // A cold start builds the app and the developer pages; under load that has taken over 120 s.
    timeout: 300_000,
  },
});
