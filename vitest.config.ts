import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
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
              miniflare: {
                // Tests never read .dev.vars or real secrets: fixtures are generated at setup.
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  KEK_V1: 'dGVzdC1rZWstdGVzdC1rZWstdGVzdC1rZWstdGVzdC0xMjM=',
                  OIDC_CLIENT_SECRET: 'test-oidc-secret',
                  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
                  SIGNER_PLATFORM_CERTIFICATE: 'replaced-in-tests',
                  SIGNER_PLATFORM_PRIVATE_KEY: 'replaced-in-tests',
                },
              },
            };
          }),
        ],
        test: {
          name: 'worker',
          include: ['src/worker/**/*.test.ts', 'test/**/*.test.ts'],
          setupFiles: ['./test/setup/apply-migrations.ts'],
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
        },
      },
    ],
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/generated/**', '**/*.test.*'] },
  },
});
