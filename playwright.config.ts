import { defineConfig, devices } from '@playwright/test';

const port = 5173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  // Local D1 + mock OIDC provider (test/mock-oidc/server.ts) are started by tools/e2e-server.ts.
  webServer: {
    command: 'node tools/e2e-server.ts',
    url: `http://localhost:${port}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
