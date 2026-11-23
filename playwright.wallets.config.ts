import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';
import { e2ePorts } from './tools/lib/e2e-ports.ts';

// Google and Samsung are dark in production and in the main run. These specs need a server built with
// the e2e release, which opens them against test/mock-wallets (docs/design/wallet-providers/e2e-release.md).
export const WALLET_SPECS = /\d+-wallets-[\w-]+\.spec\.ts/;

export default defineConfig({
  ...base,
  // auth.setup.ts refuses a server that does not match: open here, dark in every other run.
  metadata: { walletsRelease: true },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'wallets',
      testMatch: WALLET_SPECS,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node tools/e2e-server.ts',
    env: { WALLET_E2E_RELEASE: '1' },
    url: `http://localhost:${e2ePorts.web}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
