import { defineConfig, devices } from '@playwright/test';

const port = 5173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // No retries anywhere: a flake is a bug to fix, not to mask.
  retries: 0,
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
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Local D1 + mock OIDC provider (test/mock-oidc/server.ts) are started by tools/e2e-server.ts.
  webServer: {
    command: 'node tools/e2e-server.ts',
    url: `http://localhost:${port}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
