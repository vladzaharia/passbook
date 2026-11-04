import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const alias = { '@': new URL('./src', import.meta.url).pathname };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/passkit/**/*.test.ts', 'src/shared/**/*.test.ts', 'tools/**/*.test.ts'],
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest(async () => {
            const migrations = await readD1Migrations('./migrations');
            return {
              wrangler: { configPath: './wrangler.jsonc' },
              // ANALYTICS_SQL is remote-only; tests must not need Cloudflare sign-in or the network.
              remoteBindings: false,
              miniflare: {
                // Tests never read .dev.vars or real secrets: fixtures are generated at setup.
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  KEK_V1: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDc=',
                  // Pinned so a developer's .dev.vars cannot change test outcomes.
                  PUBLIC_BASE_URL: 'https://wallet.plrs.im',
                  REDIRECT_HOSTS: 'old.wallet.test',
                  OIDC_ISSUER: 'https://id.plrs.im',
                  OIDC_CLIENT_ID: 'wallet-placeholder-client-id',
                  OIDC_CLIENT_SECRET: 'test-oidc-secret',
                  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
                  SIGNER_PLATFORM_CERTIFICATE: 'replaced-in-tests',
                  SIGNER_PLATFORM_PRIVATE_KEY: 'replaced-in-tests',
                  BREAKGLASS_TOKEN_SHA256: '',
                },
              },
            };
          }),
        ],
        test: {
          name: 'worker',
          include: ['src/worker/**/*.test.ts', 'test/**/*.test.ts'],
          setupFiles: [
            './test/setup/block-network.ts',
            './test/setup/check-responses.ts',
            './test/setup/apply-migrations.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/web/**/*.test.{ts,tsx}'],
          setupFiles: ['./vitest.setup.web.ts'],
          css: false,
          // Same reason: lazy route imports are slow while the worker project saturates the CPU.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    // v8 coverage aborts inside workerd (node:inspector), so `npm run coverage` runs the worker
    // project with istanbul and the rest with v8.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/generated/**', '**/*.test.*'],
      // Per area, so each coverage run (node projects, worker project) checks the files it measures.
      thresholds: {
        'src/worker/**': { lines: 90, branches: 80 },
        'src/web/**': { lines: 85, branches: 75 },
        'src/passkit/**': { lines: 88, branches: 80 },
        'src/shared/**': { lines: 90, branches: 80 },
      },
    },
  },
});
