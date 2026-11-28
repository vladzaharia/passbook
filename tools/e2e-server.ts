// Playwright webServer: mock Pocket ID, mock Google/Samsung wallets, local D1 and Vite on E2E_PORT (default 5173; OIDC on +1, wallets on +3).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createFixtureIdentity,
  FIXTURE_IDENTITY,
} from '../src/passkit/testing/fixture-identity.ts';
import { writeDevVars } from './lib/dev-vars.ts';
import { E2E_KEK_V1 } from './lib/e2e-kek.ts';
import { e2eKeysetCommitment } from './lib/e2e-keyset.ts';
import { e2eOrigin, e2ePorts } from './lib/e2e-ports.ts';
import { E2E_RELEASE_SQL } from './lib/e2e-release.ts';

const root = resolve(import.meta.dirname, '..');
const children: ChildProcess[] = [];
const oidcIssuer = `http://localhost:${e2ePorts.oidc}`;
const walletsUrl = `http://localhost:${e2ePorts.wallets}`;
const mode = process.env.WALLET_E2E_PREVIEW === '1' ? 'preview' : 'dev';
// Google and Samsung open against the mock wallets (playwright.wallets.config.ts; docs/design/wallet-providers/e2e-release.md).
const release = process.env.WALLET_E2E_RELEASE === '1';

// Own vars file (picked up via CLOUDFLARE_ENV=e2e) so a developer's .dev.vars (other issuer, port,
// client id) can never leak into the run. Regenerated every start; throwaway fixture keys only.
const scimToken = randomBytes(24).toString('hex');
const varsFile = resolve(root, '.dev.vars.e2e');
rmSync(varsFile, { force: true });
// The platform's root pass type is a sibling under the same CA, so a spec can seed a database identity
// that signs with the Worker's own intermediate (e2e/helpers/platform-root.ts reads it from the state folder).
// It keeps the real identifier because the platform slot policy requires it; the certificate is signed by this
// throwaway test CA, lives only in the local e2e database and cannot sign a pass Apple would accept.
// The device-test pass type (Workbench device passes) is another sibling: e2e/helpers/platform-root.ts seeds it.
const fixture = await createFixtureIdentity(FIXTURE_IDENTITY, {
  siblings: [
    { ...FIXTURE_IDENTITY, passTypeIdentifier: 'pass.mobile.passbook' },
    { ...FIXTURE_IDENTITY, passTypeIdentifier: 'pass.mobile.passbook.devtest' },
  ],
});
const kek = E2E_KEK_V1;
writeDevVars(varsFile, {
  KEK_V1: kek,
  OIDC_CLIENT_ID: 'wallet-e2e',
  OIDC_ISSUER: oidcIssuer,
  PUBLIC_BASE_URL: e2eOrigin,
  // Cloudflare's always-pass Turnstile test secret (paired with the always-pass test site key).
  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
  SIGNER_PLATFORM_CERTIFICATE: fixture.certificate,
  SIGNER_PLATFORM_PRIVATE_KEY: fixture.privateKey,
  SIGNER_PLATFORM_INTERMEDIATE: fixture.intermediate,
  // A short admin sync window, so e2e/05-connections.spec.ts need not wait out 30 s.
  ADMIN_SYNC_BUCKET_MS: '2000',
  // Token used by e2e/11-breakglass.spec.ts.
  BREAKGLASS_TOKEN_SHA256: createHash('sha256').update('wbg_e2e-breakglass-token').digest('hex'),
  // The webhook URL check and sender answer this host without DNS (loopback PUBLIC_BASE_URL only, see resolver-memo.ts).
  WEBHOOK_TEST_DNS: 'hooks.example.com=93.184.216.34',
  // Polaris ID's SCIM push to /scim/v2 (test/mock-oidc/scim-push.ts); throwaway.
  SCIM_BEARER_TOKEN: scimToken,
  // The scanner document, off in production until M1.
  SCAN_ENABLED: '1',
  // Device passes are off in production until the owner's devtest step; this throwaway server runs them.
  DEVICE_PASS_ENABLED: '1',
  // Provider calls go to test/mock-wallets (honoured only on http loopback, see mock-endpoint.ts).
  WALLET_MOCK_PROVIDERS_URL: walletsUrl,
  ...(release ? { WALLET_E2E_RELEASE: '1' } : {}),
});

const env = {
  ...process.env,
  CLOUDFLARE_ENV: 'e2e',
  WALLET_E2E: '1',
  VITE_E2E: '1',
  OIDC_ISSUER: oidcIssuer,
  OIDC_CLIENT_ID: 'wallet-e2e',
  PUBLIC_BASE_URL: e2eOrigin,
  TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
  WALLET_MOCK_PROVIDERS_URL: walletsUrl,
  // The mock Polaris ID shares the OIDC mock's server; the aux binding Worker calls it (vite.config.ts).
  MOCK_POLARIS_URL: oidcIssuer,
  SCIM_BEARER_TOKEN: scimToken,
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
writeFileSync(resolve(state, 'platform-root.json'), JSON.stringify(fixture.siblings[0], null, 2), {
  mode: 0o600,
});
writeFileSync(resolve(state, 'device-test.json'), JSON.stringify(fixture.siblings[1], null, 2), {
  mode: 0o600,
});
// The Polaris ID binding's own D1 (test/idp-e2e/wrangler.jsonc), with the migration the real Worker deploys.
execFileSync(
  'npx',
  [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'polaris-binding-e2e',
    '--local',
    '--persist-to',
    state,
    '--config',
    'test/idp-e2e/wrangler.jsonc',
  ],
  { cwd: root, stdio: 'inherit' },
);
// Mock Pocket ID verifies its emails, and with trust off a first sign-in needs a mail round trip.
execFileSync(
  'npx',
  [
    'wrangler',
    'd1',
    'execute',
    'wallet-platform',
    '--local',
    '--persist-to',
    state,
    '--command',
    "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'oidc.trustEmail', 'true', 0)",
  ],
  { cwd: root, stdio: 'inherit' },
);
// The credential-reference keyset dev and prod already hold: retained-webhook reads refuse without it, and
// it is otherwise created only by the first retained credential. It commits to this run's KEK.
execFileSync(
  'npx',
  [
    'wrangler',
    'd1',
    'execute',
    'wallet-platform',
    '--local',
    '--persist-to',
    state,
    '--command',
    `INSERT INTO credential_ref_keyset (id, commitment) VALUES (1, '${await e2eKeysetCommitment(kek)}')`,
  ],
  { cwd: root, stdio: 'inherit' },
);
// The e2e release: this throwaway database releases every provider and mode (wallet_provider_releases), so the
// issuance guards run with their real bodies. Production changes the rows only through a flip migration.
if (release)
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'wallet-platform',
      '--local',
      '--persist-to',
      state,
      '--command',
      E2E_RELEASE_SQL,
    ],
    { cwd: root, stdio: 'inherit' },
  );
if (mode === 'preview') {
  execFileSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit', env });
  // The developer portal's prerendered pages (the specs that open /developers need them in the manifest).
  execFileSync('node', ['tools/build-developers.ts'], { cwd: root, stdio: 'inherit', env });
  // Vite's emitted vars omit non-secret overrides such as the local OIDC issuer.
  copyFileSync(varsFile, resolve(root, 'dist/wallet/.dev.vars'));
  // The build flattens the config without vite.config.ts's `env.e2e`, so its raised RL_SCAN_PAIR
  // never reaches preview: 30 pairs a minute from one IP refused the 3rd-Nth device of a run.
  const built = resolve(root, 'dist/wallet/wrangler.json');
  const config = JSON.parse(readFileSync(built, 'utf8'));
  // Specs sign in more than 10 times a minute (RL_LOGIN), and Workbench specs reload tools past the
  // 60 a minute of RL_API_TRY, so both are raised the same way.
  const raised = new Set(['RL_SCAN_PAIR', 'RL_LOGIN', 'RL_API_TRY']);
  for (const r of config.ratelimits ?? []) if (raised.has(r.name)) r.simple.limit = 100_000;
  writeFileSync(built, JSON.stringify(config));
  // This dist/ has raised rate limits: mark it so deploy refuses it (tools/lib/build-stamp.ts).
  writeFileSync(
    resolve(root, 'dist/wallet/build-info.json'),
    `${JSON.stringify({ sha: 'e2e', dirty: true, e2e: true })}\n`,
  );
}

children.push(
  spawn('node', ['test/mock-oidc/server.ts', String(e2ePorts.oidc)], {
    cwd: root,
    stdio: 'inherit',
    env,
  }),
);
children.push(
  spawn('node', ['test/mock-wallets/server.ts', String(e2ePorts.wallets)], {
    cwd: root,
    stdio: 'inherit',
    env,
  }),
);
children.push(
  spawn('npx', ['vite', mode, '--port', String(e2ePorts.web), '--strictPort'], {
    cwd: root,
    stdio: 'inherit',
    // Preview uses the environment already selected in its build output.
    env: mode === 'preview' ? { ...env, CLOUDFLARE_ENV: undefined } : env,
  }),
);

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
