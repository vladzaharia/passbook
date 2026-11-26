import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Session } from './demo-client.ts';
import { DEMO_OWNER_SUB } from './demo-tenancy.ts';

const DAY = 86_400_000;

/**
 * A Platform key for docs/runbooks/platform-keys.md. Minting one needs a Polaris ID session with a fresh
 * step-up, so the demo owner signs in again. The secret is shown once: it goes to an untracked local file
 * and is never printed.
 */
export async function seedPlatformKey(
  base: string,
  keys: { name: string; revokedAt?: number | null }[],
  root: string,
): Promise<void> {
  const key = {
    name: 'Ops status',
    orgId: null,
    scopes: ['platform:read', 'platform:settings', 'platform:wallet'],
    expiresAt: Date.now() + 30 * DAY,
    ipAllow: ['203.0.113.0/24'],
  };
  const file = resolve(root, '.wrangler/seed-platform-key.env');
  if (!keys.some((k) => k.name === key.name && !k.revokedAt)) {
    const operator = new Session(base);
    await operator.oidc(DEMO_OWNER_SUB);
    const made = await operator.send('POST', '/api/v1/api-keys', key);
    mkdirSync(resolve(root, '.wrangler'), { recursive: true });
    writeFileSync(file, `PASSBOOK_KEY=${made.secret}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  if (existsSync(file))
    console.log(
      `Platform key "${key.name}": PASSBOOK_KEY is in ${relative(root, file)} (docs/runbooks/platform-keys.md).`,
    );
  else
    console.log(`Platform key "${key.name}" exists but its secret is gone: revoke it and rerun.`);
}
