import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { createFixtureIdentity } from './src/passkit/testing/fixture-identity.ts';

const alias = {
  '@': new URL('./src', import.meta.url).pathname,
  '@passbook/sdk': new URL('./sdk/typescript/src/index.ts', import.meta.url).pathname,
};
// Coverage instrumentation (istanbul in workerd, v8 in node) makes tests 2–3× slower on CI runners.
const timeout = process.argv.includes('--coverage') ? 90_000 : 30_000;

// Worker tests log each distinct SQL text as `@@SQL@@<json>` (test/setup/sql-corpus.ts); the lines are
// collected per shard for tools/check-sql-depth.ts and kept out of the test output.
const corpusDir = new URL('./.wrangler/sql-corpus/', import.meta.url).pathname;
const shard = process.argv
  .find((arg) => arg.startsWith('--shard='))
  ?.slice(8)
  .replace('/', 'of');
// SQL_CORPUS_KEEP=1 appends across chunked runs instead of starting a fresh corpus.
if (!process.env.SQL_CORPUS_KEEP) rmSync(corpusDir, { recursive: true, force: true });
mkdirSync(corpusDir, { recursive: true });

// Tapped before reporters filter anything, so the corpus is collected whatever `silent` is (agent runs
// hide passed-test logs) and what a run prints does not change. The marked lines are not printed.
type Log = { content: string };
type Report = (name: string, ...args: unknown[]) => Promise<void>;
const takeCorpusLines = (log: Log): boolean => {
  const lines = log.content.split('\n').filter((line) => line.length > 0);
  const marked = lines.filter((line) => line.startsWith('@@SQL@@'));
  if (marked.length === 0) return false;
  appendFileSync(
    `${corpusDir}${shard ?? 'local'}.jsonl`,
    marked.map((line) => `${line.slice(7)}\n`).join(''),
  );
  log.content = lines.filter((line) => !line.startsWith('@@SQL@@')).join('\n');
  return log.content.length === 0;
};

export default defineConfig({
  // Not under node_modules, which worktrees share (see vite.config.ts).
  cacheDir: new URL('./.cache/vite', import.meta.url).pathname,
  resolve: { alias },
  plugins: [
    {
      name: 'sql-corpus',
      // `report` is internal to vitest and absent from its types.
      configureVitest: ({ vitest }) => {
        const target = vitest as unknown as { report: Report };
        const report = target.report.bind(vitest);
        target.report = (name, ...args) =>
          name === 'onUserConsoleLog' && takeCorpusLines(args[0] as Log)
            ? Promise.resolve()
            : report(name, ...args);
      },
    },
  ],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/passkit/**/*.test.ts', 'src/shared/**/*.test.ts', 'tools/**/*.test.ts'],
          // Image and package tests decode PNGs; under v8 coverage (coverage-node) they pass 5 s.
          testTimeout: timeout,
          hookTimeout: timeout,
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest(async () => {
            const migrations = await readD1Migrations('./migrations');
            // Workflows started through a real binding run in workerd with these bindings, not makeEnv's.
            const signer = await createFixtureIdentity(undefined, {
              now: new Date('2026-01-01T00:00:00.000Z'),
              days: 3650,
              caDays: 3650,
            });
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
                  SIGNER_PLATFORM_CERTIFICATE: signer.certificate,
                  SIGNER_PLATFORM_PRIVATE_KEY: signer.privateKey,
                  SIGNER_PLATFORM_INTERMEDIATE: signer.intermediate,
                  BREAKGLASS_TOKEN_SHA256: '',
                  // Production keeps the scanner off until M1; tests cover it on (and off, by override).
                  SCAN_ENABLED: '1',
                  // Test-only: lets stmt() record SQL text for tools/check-sql-depth.ts.
                  SQL_CORPUS: '1',
                },
              },
            };
          }),
        ],
        test: {
          name: 'worker',
          // lucide-react's barrel is ~4300 icon modules; workerd fetched each one per test file (10+ s).
          // Pre-bundled it is one module.
          deps: { optimizer: { ssr: { enabled: true, include: ['lucide-react'] } } },
          include: ['src/worker/**/*.test.ts', 'test/**/*.test.ts'],
          // A race test runs several D1 batches in workerd; on a shared CI runner that passes 5 s.
          testTimeout: timeout,
          hookTimeout: timeout,
          setupFiles: [
            './test/setup/als-disable.ts',
            './test/setup/block-network.ts',
            './test/setup/check-responses.ts',
            './test/setup/apply-migrations.ts',
            './test/setup/sql-corpus.ts',
            './test/setup/settle-wait-until.ts',
            './test/setup/settle-workflows.ts',
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
          testTimeout: timeout,
          hookTimeout: timeout,
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
