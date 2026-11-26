import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';

const BASE = '/api/v1/platform/apple/identities';
let appEnv: AppEnv;
let fx: Fixtures;
let app: ReturnType<typeof createApp>;
let admin: SessionFixture;
let created: string[];
let keySeq = 0;

const call = (
  path: string,
  who: SessionFixture | null,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) =>
  app.request(
    path,
    {
      method: init.method ?? 'GET',
      headers: {
        ...(who?.headers ?? {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    appEnv,
  );

const key = (): Record<string, string> => ({ 'idempotency-key': `k-${++keySeq}` });
const start = (who: SessionFixture | null, body: unknown = { slot: 'root' }, headers = key()) =>
  call(BASE, who, { method: 'POST', body, headers });
const makeDefault = (who: SessionFixture | null, id: string, headers = key()) =>
  call(`${BASE}/${id}/default`, who, { method: 'POST', headers });

async function slotRow(id: string, passType: string, purpose: string, ready = true) {
  await run(
    env.DB,
    "INSERT OR IGNORE INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES (?, 'pass_signer', 1, x'00', x'00', x'00', 1)",
    [`cred-${id}`],
  );
  await run(
    env.DB,
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, not_after,
        provenance, purpose, apns_health, is_default, issuing, created_at)
     VALUES (?, NULL, ?, ?, 'TEAM123456', 'db', ?, 'PEM', ?, 'platform', ?, ?, 0, ?, 1)`,
    [
      id,
      id,
      passType,
      `cred-${id}`,
      fx.clock.now() + 90 * 86_400_000,
      purpose,
      ready ? 'healthy' : 'unknown',
      ready ? 1 : 0,
    ],
  );
}

beforeAll(async () => {
  appEnv = await makeEnv();
});

beforeEach(async () => {
  fx = fixtures(appEnv);
  created = [];
  (appEnv as unknown as Record<string, unknown>).IDENTITY_PROVISION = {
    create: async ({ id }: { id: string }) => {
      created.push(id);
      return { id };
    },
  };
  admin = await makeSession(fx, { userId: (await makeUser(fx)).id, roles: ['admin', 'user'] });
  await run(env.DB, 'DELETE FROM registrations');
  await run(env.DB, 'DELETE FROM devices');
  await run(env.DB, "DELETE FROM identity_runs WHERE target_id LIKE 'platform:%'");
  await run(env.DB, "DELETE FROM signing_identities WHERE id LIKE 'pi4-%'");
  await run(env.DB, "DELETE FROM credentials WHERE id LIKE 'cred-pi4-%'");
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(appEnv, fx.clock),
      apiKeys: createApiKeyStore(appEnv, fx.clock),
    },
    clock: fx.clock,
  });
});

describe('GET /platform/apple/identities', () => {
  it('lists the platform rows with their slot, managed kind and open runs', async () => {
    await slotRow('pi4-root', 'pass.mobile.passbook', 'passes');
    const res = await call(BASE, admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; slot: string | null; managed: string; registrationCount: number }[];
      openRuns: unknown[];
    };
    const root = body.items.find((i) => i.id === 'pi4-root');
    expect(root).toMatchObject({ slot: 'root', managed: 'connector', registrationCount: 0 });
    expect(body.openRuns).toEqual([]);
    expect(body.items.every((i) => (i as { orgId?: unknown }).orgId === null)).toBe(true);
  });

  it('refuses everyone but a platform admin session', async () => {
    const member = await makeSession(fx, { userId: (await makeUser(fx)).id });
    await expectProblem(await call(BASE, member), 403, 'FORBIDDEN');
    expect((await call(BASE, null)).status).toBe(401);
    expect((await call(BASE, null, { headers: { authorization: 'Bearer pbo_x' } })).status).toBe(
      401,
    );
  });
});

describe('POST /platform/apple/identities', () => {
  it('starts a run for a slot and replays the same key', async () => {
    const headers = key();
    const first = await start(admin, { slot: 'devtest' }, headers);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      kind: 'provision',
      targetId: 'platform:devtest',
      orgId: null,
    });
    const replay = await start(admin, { slot: 'devtest' }, headers);
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(created).toHaveLength(1);
    await expectProblem(
      await start(admin, { slot: 'root' }, headers),
      422,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('refuses a slot that already has a certificate', async () => {
    await slotRow('pi4-root', 'pass.mobile.passbook', 'passes');
    await expectProblem(await start(admin), 409, 'IDENTITY_ALREADY_PROVISIONED');
    expect(created).toHaveLength(0);
  });

  it('refuses a missing Idempotency-Key and an unknown slot', async () => {
    await expectProblem(await start(admin, { slot: 'root' }, {}), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    for (const slot of ['__proto__', 'constructor', 'Root', 'platform', ''])
      expect((await start(admin, { slot })).status).toBe(422);
    expect((await start(admin, {})).status).toBe(422);
    expect(created).toHaveLength(0);
  });

  it('refuses a member, an email-link session, no session and a key', async () => {
    const member = await makeSession(fx, { userId: (await makeUser(fx)).id });
    await expectProblem(await start(member), 403, 'FORBIDDEN');
    const link = await makeSession(fx, {
      userId: (await makeUser(fx)).id,
      roles: ['admin', 'user'],
      amr: 'magic_link',
    });
    expect((await start(link)).status).toBeGreaterThanOrEqual(401);
    expect((await start(link)).status).toBeLessThan(500);
    expect((await start(null)).status).toBe(401);
    expect(
      (await start(null, { slot: 'root' }, { ...key(), authorization: 'Bearer pbo_x' })).status,
    ).toBe(401);
    expect(created).toHaveLength(0);
  });

  it('needs a fresh step-up', async () => {
    const stale = await makeSession(fx, {
      userId: (await makeUser(fx)).id,
      roles: ['admin', 'user'],
      authTime: fx.clock.now() - 11 * 60_000,
    });
    await expectProblem(await start(stale), 403, 'STEP_UP_REQUIRED');
    expect(created).toHaveLength(0);
  });

  it('needs the CSRF token', async () => {
    const { 'x-csrf-token': _csrf, ...noCsrf } = admin.headers;
    const res = await app.request(
      BASE,
      {
        method: 'POST',
        headers: { ...noCsrf, ...key(), 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'root' }),
      },
      appEnv,
    );
    expect(res.status).toBe(403);
    expect(created).toHaveLength(0);
  });
});

describe('POST /platform/apple/identities/{id}/default', () => {
  const flags = async () =>
    all<{ id: string; is_default: number }>(
      env.DB,
      "SELECT id, is_default FROM signing_identities WHERE id IN ('platform', 'pi4-root')",
    );

  it('refuses an identity that is not ready, and an unknown one', async () => {
    await slotRow('pi4-root', 'pass.mobile.passbook', 'passes', false);
    await expectProblem(await makeDefault(admin, 'pi4-root'), 409, 'IDENTITY_NOT_READY');
    await expectProblem(await makeDefault(admin, 'pi4-nothing'), 404, 'IDENTITY_NOT_FOUND');
    expect((await flags()).find((r) => r.id === 'pi4-root')?.is_default).toBe(0);
  });

  it('refuses a device-test identity', async () => {
    await slotRow('pi4-dev', 'pass.mobile.passbook.devtest', 'device_test');
    await expectProblem(await makeDefault(admin, 'pi4-dev'), 409, 'IDENTITY_NOT_READY');
  });

  it('flips the default once a device registered a pass, and replays', async () => {
    await slotRow('pi4-root', 'pass.mobile.passbook', 'passes');
    const personal = await makeOrg(fx, { personalUserId: (await makeUser(fx)).id });
    const pass = await makePass(fx, { orgId: personal.id, template: makeTemplate().resolved });
    await run(
      env.DB,
      `INSERT INTO audit_log (org_id, actor_type, action, target_type, target_id, at)
       VALUES (NULL, 'system', 'identity.apns_probe', 'identity', 'pi4-root', ?)`,
      [fx.clock.now()],
    );
    await run(
      env.DB,
      'INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, ?, ?, ?)',
      ['pi4-dev-1', 'pi4-root', 't', fx.clock.now()],
    );
    await run(
      env.DB,
      'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, ?, ?, ?)',
      ['pi4-dev-1', 'pi4-root', pass.id, fx.clock.now()],
    );
    const headers = key();
    const res = await makeDefault(admin, 'pi4-root', headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identityId: 'pi4-root', changed: true });
    expect((await flags()).find((r) => r.id === 'pi4-root')?.is_default).toBe(1);
    const replay = await makeDefault(admin, 'pi4-root', headers);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await (await makeDefault(admin, 'pi4-root')).json()).toEqual({
      identityId: 'pi4-root',
      changed: false,
    });
  });

  it('refuses a missing key, a member, no session and a stale step-up', async () => {
    await slotRow('pi4-root', 'pass.mobile.passbook', 'passes');
    await expectProblem(await makeDefault(admin, 'pi4-root', {}), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const member = await makeSession(fx, { userId: (await makeUser(fx)).id });
    await expectProblem(await makeDefault(member, 'pi4-root'), 403, 'FORBIDDEN');
    expect((await makeDefault(null, 'pi4-root')).status).toBe(401);
    const stale = await makeSession(fx, {
      userId: (await makeUser(fx)).id,
      roles: ['admin', 'user'],
      authTime: fx.clock.now() - 11 * 60_000,
    });
    await expectProblem(await makeDefault(stale, 'pi4-root'), 403, 'STEP_UP_REQUIRED');
    expect((await flags()).find((r) => r.id === 'pi4-root')?.is_default).toBe(0);
  });
});
