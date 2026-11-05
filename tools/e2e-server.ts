// Playwright webServer: mock Pocket ID + local D1 + vite dev on 5173.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFixtureIdentity } from '../src/passkit/testing/fixture-identity.ts';
import { writeDevVars } from './lib/dev-vars.ts';

const root = resolve(import.meta.dirname, '..');
const children: ChildProcess[] = [];

// Own vars file (picked up via CLOUDFLARE_ENV=e2e) so a developer's .dev.vars (other issuer, port,
// client id) can never leak into the run. Regenerated every start; throwaway fixture keys only.
const varsFile = resolve(root, '.dev.vars.e2e');
rmSync(varsFile, { force: true });
const fixture = await createFixtureIdentity();
writeDevVars(varsFile, {
  KEK_V1: randomBytes(32).toString('base64'),
  OIDC_CLIENT_ID: 'wallet-e2e',
  OIDC_ISSUER: 'http://localhost:5174',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  // Cloudflare's always-pass Turnstile test secret (paired with the always-pass test site key).
  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
  SIGNER_PLATFORM_CERTIFICATE: fixture.certificate,
  SIGNER_PLATFORM_PRIVATE_KEY: fixture.privateKey,
  SIGNER_PLATFORM_INTERMEDIATE: fixture.intermediate,
  // A short admin sync window, so e2e/05-connections.spec.ts need not wait out 30 s.
  ADMIN_SYNC_BUCKET_MS: '2000',
  // Token used by e2e/11-breakglass.spec.ts.
  BREAKGLASS_TOKEN_SHA256: createHash('sha256').update('wbg_e2e-breakglass-token').digest('hex'),
  // The scanner document, off in production until M1.
  SCAN_ENABLED: '1',
});

const env = {
  ...process.env,
  CLOUDFLARE_ENV: 'e2e',
  WALLET_E2E: '1',
  OIDC_ISSUER: 'http://localhost:5174',
  OIDC_CLIENT_ID: 'wallet-e2e',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
};

execFileSync('node', ['tools/build-templates.ts'], { cwd: root, stdio: 'inherit' });
// A fresh database every run: day-scoped caps (magic links per IP) would otherwise carry over
// from earlier runs and refuse sign-in mail. vite.config.ts points the e2e Worker here too.
const state = resolve(root, '.wrangler/e2e-state');
rmSync(state, { recursive: true, force: true });
execFileSync(
  'npx',
  ['wrangler', 'd1', 'migrations', 'apply', 'wallet-platform', '--local', '--persist-to', state],
  { cwd: root, stdio: 'inherit' },
);

children.push(
  spawn('node', ['test/mock-oidc/server.ts', '5174'], { cwd: root, stdio: 'inherit', env }),
);
children.push(
  spawn('npx', ['vite', 'dev', '--port', '5173', '--strictPort'], {
    cwd: root,
    stdio: 'inherit',
    env,
  }),
);

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
