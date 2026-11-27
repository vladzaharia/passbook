// Platform-keys PK-6c: the platform audit log and its export take a Platform key with platform:audit.
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type Fixtures,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';

let env: AppEnv;
let fx: Fixtures;
let app: ReturnType<typeof createApp>;
let admin: SessionFixture;

const call = (path: string, headers: Record<string, string>) =>
  app.request(`/api/v1/audit/platform${path}`, { headers }, env);

async function platformKey(scopes: string[]) {
  const key = await makeApiKey(fx, {
    orgId: null,
    kind: 'platform',
    scopes,
    expiresAt: fx.clock.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
  });
  return { id: key.id, headers: { ...key.headers, 'cf-connecting-ip': '198.51.100.7' } };
}

beforeAll(async () => {
  env = await makeEnv();
  fx = fixtures(env);
  admin = await makeSession(fx, { userId: (await makeUser(fx)).id, roles: ['admin', 'user'] });
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(env, fx.clock),
      apiKeys: createApiKeyStore(env, fx.clock),
    },
    clock: fx.clock,
  });
}, 30_000);

describe('a Platform key on the platform audit log', () => {
  it('reads the log and the export with platform:audit, and a person still can', async () => {
    const key = await platformKey(['platform:audit']);
    expect((await call('', key.headers)).status).toBe(200);
    const csv = await call('/export', key.headers);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect((await call('', admin.headers)).status).toBe(200);
    expect((await call('/export', admin.headers)).status).toBe(200);
  });

  it('reads with platform:read, and refuses another scope', async () => {
    const reader = await platformKey(['platform:read']);
    expect((await call('', reader.headers)).status).toBe(200);
    expect((await call('/export', reader.headers)).status).toBe(200);
    const other = await platformKey(['platform:groups']);
    await expectProblem(await call('', other.headers), 403, 'MISSING_SCOPE');
    await expectProblem(await call('/export', other.headers), 403, 'MISSING_SCOPE');
  });

  it('refuses an org key', async () => {
    const org = await makeOrg(fx);
    const orgKey = await makeApiKey(fx, { orgId: org.id, scopes: ['audit:read'] });
    await expectProblem(await call('', orgKey.headers), 403, 'PLATFORM_KEY_REQUIRED');
    await expectProblem(await call('/export', orgKey.headers), 403, 'PLATFORM_KEY_REQUIRED');
  });

  it("audits a key's export as the key, with the row count only, and limits it to 2 an hour", async () => {
    const key = await platformKey(['platform:audit']);
    expect((await call('/export', key.headers)).status).toBe(200);
    const rows = await all<{
      actor_type: string;
      actor_id: string;
      org_id: string | null;
      detail: string;
    }>(
      env.DB,
      "SELECT actor_type, actor_id, org_id, detail FROM audit_log WHERE action = 'audit.export' AND actor_id = ?",
      [key.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'api_key', org_id: null });
    expect(Object.keys(JSON.parse(rows[0]?.detail ?? '{}')).sort()).toEqual(['rows', 'truncated']);
    expect((await call('/export', key.headers)).status).toBe(200);
    expect((await call('/export', key.headers)).status).toBe(429);
  });
});
