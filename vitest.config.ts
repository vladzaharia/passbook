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
              wrangler: { configPath: './test/wrangler.vitest.jsonc' },
              // This file lives under test/ so Wrangler cannot load the repository-root .dev.vars.
              // ANALYTICS_SQL is remote-only; tests must not need Cloudflare sign-in or the network.
              remoteBindings: false,
              miniflare: {
                // The keyset suite needs a fresh D1 database for each singleton/retention scenario.
                d1Databases: Object.fromEntries(
                  Array.from({ length: 32 }, (_, index) => [
                    `KEYSET_TEST_DB_${index}`,
                    `credential-keyset-test-${index}`,
                  ]),
                ),
                // Tests never read .dev.vars or real secrets: fixtures are generated at setup.
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  KEK_V1: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDc=',
                  // Pinned so a developer's .dev.vars cannot change test outcomes.
                  PUBLIC_BASE_URL: 'https://passbook.mobile',
                  REDIRECT_HOSTS: 'old.wallet.test',
                  OIDC_ISSUER: 'https://id.plrs.im',
                  OIDC_CLIENT_ID: 'wallet-placeholder-client-id',
                  OIDC_CLIENT_SECRET: 'test-oidc-secret',
                  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
                  SIGNER_PLATFORM_CERTIFICATE: 'replaced-in-tests',
                  SIGNER_PLATFORM_PRIVATE_KEY: 'replaced-in-tests',
                  BREAKGLASS_TOKEN_SHA256: '',
                  // Production keeps the scanner off until M1; tests cover it on (and off, by override).
                  SCAN_ENABLED: '1',
                },
              },
            };
          }),
        ],
        test: {
          name: 'worker',
          include: ['src/worker/**/*.test.ts', 'test/**/*.test.ts'],
          // A race test runs several D1 batches in workerd; on a shared CI runner that passes 5 s.
          testTimeout: 30_000,
          hookTimeout: 30_000,
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
          environmentOptions: { jsdom: { url: 'http://localhost:5173' } },
          include: ['src/web/**/*.test.{ts,tsx}'],
          setupFiles: ['./vitest.setup.web.ts'],
          // Node 25+ defines an empty global localStorage that shadows jsdom's.
          execArgv: ['--no-experimental-webstorage'],
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
      // A CI shard covers part of the suite; thresholds apply when the shards' blobs are merged.
      thresholds: process.env.COVERAGE_SHARD
        ? {}
        : {
            'src/worker/**': { lines: 90, branches: 80 },
            'src/web/**': { lines: 85, branches: 75 },
            'src/passkit/**': { lines: 88, branches: 80 },
            'src/shared/**': { lines: 90, branches: 80 },
          },
    },
  },
});
