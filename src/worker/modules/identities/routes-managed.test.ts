import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';

let appEnv: AppEnv;
let fx: Fixtures;
let app: ReturnType<typeof createApp>;
let admin: SessionFixture;
let member: SessionFixture;
let other: SessionFixture;
let orgA: string;
let orgB: string;
let trialOrg: string;
let created: string[];
let ledger: unknown[];

async function addMember(orgId: string, userId: string) {
  const invitationId = fx.ids.id();
  const now = fx.clock.now();
  await run(
    appEnv.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, '["org_admin"]', fx.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    appEnv.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, '["org_admin"]', ?)`,
    [fx.ids.id(), orgId, userId, invitationId, now],
  );
}

const insertIdentity = (id: string, orgId: string | null, extra = '') =>
  run(
    env.DB,
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, is_default, created_at, provenance, rotation)
     VALUES (?, ?, ?, ?, 'TEAM123456', 'env', ?, 0, 1, ${extra || "'own', 'manual'"})`,
    [id, orgId, `Label ${id}`, `pass.test.${id}`, id.toUpperCase()],
  );

/** The provisioner binding, a stand-in (or none). */
const bindApple = (binding: unknown) => Reflect.set(appEnv, 'APPLE', binding);

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

const items = async (res: Response) =>
  ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id).sort();

beforeAll(async () => {
  appEnv = await makeEnv();
});

beforeEach(async () => {
  fx = fixtures(appEnv);
  created = [];
  ledger = [];
  (appEnv as unknown as Record<string, unknown>).IDENTITY_PROVISION = {
    create: async ({ id }: { id: string }) => {
      created.push(id);
      return { id };
    },
  };
  bindApple({ calls: async () => ledger });
  admin = await makeSession(fx, { userId: (await makeUser(fx)).id, roles: ['admin', 'user'] });
  const m = await makeUser(fx);
  member = await makeSession(fx, { userId: m.id });
  other = await makeSession(fx, { userId: (await makeUser(fx)).id });
  orgA = (await makeOrg(fx)).id;
  orgB = (await makeOrg(fx)).id;
  trialOrg = (await makeOrg(fx, { preset: 'trial' })).id;
  await addMember(orgA, m.id);
  await run(env.DB, "DELETE FROM signing_identities WHERE id LIKE 'wi-%'");
  await insertIdentity('wi-a', orgA);
  await insertIdentity('wi-b', orgB, "'managed', 'auto'");
  await run(env.DB, "UPDATE signing_identities SET cert_pem = 'PEM' WHERE id = 'wi-b'");
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(appEnv, fx.clock),
      apiKeys: createApiKeyStore(appEnv, fx.clock),
    },
    clock: fx.clock,
  });
});

describe('GET /wallet-identities', () => {
  it('gives a platform admin any organization or the whole list', async () => {
    expect(await items(await call(`/api/v1/wallet-identities?orgId=${orgB}`, admin))).toEqual([
      'wi-b',
    ]);
    expect(await items(await call('/api/v1/wallet-identities', admin))).toEqual(
      expect.arrayContaining(['wi-a', 'wi-b']),
    );
  });

  it('gives a member their own organization only', async () => {
    expect(await items(await call(`/api/v1/wallet-identities?orgId=${orgA}`, member))).toEqual([
      'wi-a',
    ]);
    await expectProblem(
      await call(`/api/v1/wallet-identities?orgId=${orgB}`, member),
      403,
      'FORBIDDEN',
    );
    await expectProblem(
      await call(`/api/v1/wallet-identities?orgId=${orgA}`, other),
      403,
      'FORBIDDEN',
    );
    await expectProblem(await call('/api/v1/wallet-identities', member), 422, 'ORG_REQUIRED');
    expect((await call(`/api/v1/wallet-identities?orgId=${orgA}`, null)).status).toBe(401);
  });

  it('filters by kind and status and reads kind, status and renewal', async () => {
    const res = await call(`/api/v1/wallet-identities?kind=managed&orgId=${orgB}`, admin);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: 'managed', rotation: 'auto', issuing: true });
    const none = await call(`/api/v1/wallet-identities?status=retired&orgId=${orgB}`, admin);
    expect(await items(none)).toEqual([]);
  });
});

describe('POST /orgs/{orgId}/identities/apple', () => {
  const start = (orgId: string, who: SessionFixture, body: unknown = {}, key?: string) =>
    call(`/api/v1/orgs/${orgId}/identities/apple`, who, {
      method: 'POST',
      body,
      headers: key ? { 'idempotency-key': key } : {},
    });

  it('starts a run for an admin or the org owner, and refuses other organizations', async () => {
    const res = await start(orgA, member);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ kind: 'provision', targetId: orgA, state: 'queued' });
    expect(created).toHaveLength(1);
    const fresh = (await makeOrg(fx)).id;
    expect((await start(fresh, admin)).status).toBe(202);
    await expectProblem(await start(orgB, admin), 409, 'IDENTITY_ALREADY_PROVISIONED');
    await expectProblem(await start(orgB, member), 403, 'FORBIDDEN');
    await expectProblem(await start(orgA, other), 403, 'FORBIDDEN');
    expect(
      (await call(`/api/v1/orgs/${orgA}/identities/apple`, null, { method: 'POST', body: {} }))
        .status,
    ).toBe(401);
  });

  it('is gated by the identity.managed entitlement, for an admin too', async () => {
    await expectProblem(await start(trialOrg, admin), 403, 'FEATURE_NOT_INCLUDED');
    expect(created).toHaveLength(0);
  });

  it('lets only a platform admin choose the handle', async () => {
    await expectProblem(
      await start(orgA, member, { handle: 'nike' }),
      403,
      'IDENTITY_HANDLE_ADMIN_ONLY',
    );
    expect(created).toHaveLength(0);
    expect((await start(orgA, member, {})).status).toBe(202);
  });

  it('refuses a reserved or invalid handle', async () => {
    await expectProblem(
      await start(orgA, admin, { handle: 'wallet' }),
      422,
      'IDENTITY_HANDLE_RESERVED',
    );
    await expectProblem(await start(orgA, admin, { handle: 'Not Valid' }), 422, 'VALIDATION');
  });

  it('replays an Idempotency-Key and refuses it for another request', async () => {
    const first = await start(orgA, admin, { handle: 'acme' }, 'k1');
    const replay = await start(orgA, admin, { handle: 'acme' }, 'k1');
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(await first.json());
    expect(created).toHaveLength(1);
    await expectProblem(
      await start(orgA, admin, { handle: 'other' }, 'k1'),
      422,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });
});

describe('identity runs', () => {
  async function failedRun() {
    const res = await call(`/api/v1/orgs/${orgA}/identities/apple`, admin, {
      method: 'POST',
      body: {},
    });
    const { id } = (await res.json()) as { id: string };
    await run(env.DB, "UPDATE identity_runs SET state = 'failed', error_code = 'X' WHERE id = ?", [
      id,
    ]);
    return id;
  }

  it('lists and reads runs for an admin and for the org, not for another org', async () => {
    const id = await failedRun();
    expect(await items(await call(`/api/v1/identity-runs?orgId=${orgA}`, member))).toEqual([id]);
    expect((await call(`/api/v1/identity-runs/${id}`, member)).status).toBe(200);
    expect((await call(`/api/v1/identity-runs/${id}`, admin)).status).toBe(200);
    await expectProblem(
      await call(`/api/v1/identity-runs/${id}`, other),
      404,
      'IDENTITY_RUN_NOT_FOUND',
    );
    await expectProblem(await call(`/api/v1/identity-runs?orgId=${orgA}`, other), 403, 'FORBIDDEN');
    await expectProblem(await call('/api/v1/identity-runs', member), 422, 'ORG_REQUIRED');
    await expectProblem(
      await call('/api/v1/identity-runs/nope', admin),
      404,
      'IDENTITY_RUN_NOT_FOUND',
    );
  });

  it('retries a failed run, and refuses to retry an open one', async () => {
    const id = await failedRun();
    const retry = await call(`/api/v1/identity-runs/${id}/retry`, member, { method: 'POST' });
    expect(retry.status).toBe(202);
    const next = (await retry.json()) as { id: string; state: string };
    expect(next.id).not.toBe(id);
    await expectProblem(
      await call(`/api/v1/identity-runs/${next.id}/retry`, member, { method: 'POST' }),
      409,
      'IDENTITY_RUN_OPEN',
    );
    await expectProblem(
      await call(`/api/v1/identity-runs/${id}/retry`, other, { method: 'POST' }),
      404,
      'IDENTITY_RUN_NOT_FOUND',
    );
  });

  it('refuses a retry after the organization lost the feature', async () => {
    const id = await failedRun();
    await run(env.DB, "UPDATE org_entitlements SET preset = 'trial' WHERE org_id = ?", [orgA]);
    await expectProblem(
      await call(`/api/v1/identity-runs/${id}/retry`, member, { method: 'POST' }),
      403,
      'FEATURE_NOT_INCLUDED',
    );
  });

  it('cancels an open run for an admin only', async () => {
    const res = await call(`/api/v1/orgs/${orgA}/identities/apple`, admin, {
      method: 'POST',
      body: {},
    });
    const { id } = (await res.json()) as { id: string };
    await expectProblem(
      await call(`/api/v1/identity-runs/${id}/cancel`, member, { method: 'POST' }),
      403,
      'FORBIDDEN',
    );
    const cancelled = await call(`/api/v1/identity-runs/${id}/cancel`, admin, { method: 'POST' });
    expect(await cancelled.json()).toMatchObject({ state: 'cancelled' });
    await expectProblem(
      await call(`/api/v1/identity-runs/${id}/cancel`, admin, { method: 'POST' }),
      409,
      'IDENTITY_RUN_CLOSED',
    );
  });
});

describe('identity actions', () => {
  it('reads certificate history for a platform admin and the org member, not another org', async () => {
    await run(
      env.DB,
      `INSERT INTO identity_certificates (id, identity_id, origin, state, created_at) VALUES ('wc-1', 'wi-a', 'asc', 'superseded', 5)`,
    );
    expect(await items(await call('/api/v1/identities/wi-a/certificates', member))).toEqual([
      'wc-1',
    ]);
    expect((await call('/api/v1/identities/wi-a/certificates', admin)).status).toBe(200);
    await expectProblem(
      await call('/api/v1/identities/wi-b/certificates', member),
      404,
      'IDENTITY_NOT_FOUND',
    );
    await expectProblem(
      await call('/api/v1/identities/nope/certificates', admin),
      404,
      'IDENTITY_NOT_FOUND',
    );
  });

  it('keeps renew, update and revoke for platform admins', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/identities/wi-a/renew'],
      ['PATCH', '/api/v1/identities/wi-a'],
      ['POST', '/api/v1/identities/wi-a/revoke-certificate'],
    ] as const)
      await expectProblem(await call(path, member, { method, body: {} }), 403, 'FORBIDDEN');
  });

  it('renews a managed identity and refuses one that is not', async () => {
    await expectProblem(
      await call('/api/v1/identities/wi-a/renew', admin, { method: 'POST' }),
      409,
      'IDENTITY_NOT_ROTATABLE',
    );
  });

  it('pauses auto-renew and stops new passes, and resumes a managed or platform identity', async () => {
    await run(
      env.DB,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, is_default, created_at, provenance, rotation, cert_pem)
       VALUES ('wi-plat', NULL, 'Plat', 'pass.test.plat', 'TEAM123456', 'env', 'WIPLAT', 0, 1, 'platform', 'manual', 'PEM')`,
    );
    const resumed = await call('/api/v1/identities/wi-plat', admin, {
      method: 'PATCH',
      body: { rotation: 'auto' },
    });
    expect(await resumed.json()).toMatchObject({ rotation: 'auto' });
    const paused = await call('/api/v1/identities/wi-b', admin, {
      method: 'PATCH',
      body: { rotation: 'manual', issuing: false },
    });
    expect(await paused.json()).toMatchObject({
      rotation: 'manual',
      issuing: false,
      status: 'retired',
    });
    await expectProblem(
      await call('/api/v1/identities/wi-a', admin, { method: 'PATCH', body: { rotation: 'auto' } }),
      409,
      'IDENTITY_NOT_ROTATABLE',
    );
  });

  describe('revoke-certificate', () => {
    const HOUR = 3_600_000;
    let oidcAdmin: SessionFixture;
    beforeEach(async () => {
      oidcAdmin = admin;
      const now = fx.clock.now();
      await run(
        env.DB,
        `INSERT INTO identity_certificates (id, identity_id, origin, state, asc_certificate_id, created_at, ended_at)
         VALUES ('wc-old', 'wi-b', 'asc', 'superseded', 'asc-1', 5, ?),
                ('wc-up', 'wi-b', 'upload', 'superseded', NULL, 5, ?),
                ('wc-new', 'wi-b', 'asc', 'active', 'asc-2', 6, NULL)`,
        [now - 100 * HOUR, now - 100 * HOUR],
      );
    });
    const revoke = (
      certificateId: string,
      confirm = 'pass.test.wi-b',
      who = oidcAdmin,
      id = 'wi-b',
    ) =>
      call(`/api/v1/identities/${id}/revoke-certificate`, who, {
        method: 'POST',
        body: { certificateId, reason: 'compromised', confirm },
      });

    it('starts a revoke run after the wait, and refuses each unsafe case', async () => {
      await expectProblem(await revoke('wc-old', 'nope'), 422, 'IDENTITY_CONFIRM_MISMATCH');
      await expectProblem(await revoke('wc-new'), 409, 'IDENTITY_CERT_NOT_REVOCABLE');
      await expectProblem(await revoke('wc-up'), 409, 'IDENTITY_CERT_NOT_REVOCABLE');
      const ok = await revoke('wc-old');
      expect(ok.status).toBe(202);
      expect(await ok.json()).toMatchObject({ kind: 'revoke', targetId: 'wi-b', state: 'queued' });
      expect(created).toHaveLength(1);
    });

    it('waits for the reissue or 72 hours', async () => {
      await run(env.DB, "UPDATE identity_certificates SET ended_at = ? WHERE id = 'wc-old'", [
        fx.clock.now() - HOUR,
      ]);
      await expectProblem(await revoke('wc-old'), 409, 'IDENTITY_REISSUE_PENDING');
      await run(
        env.DB,
        `INSERT INTO workflow_runs (instance_id, kind, target_id, status, started_at, finished_at)
         VALUES ('wf-1', 'bulk_reissue', 'wi-b', 'complete', ?, ?)`,
        [fx.clock.now() - 30 * 60_000, fx.clock.now()],
      );
      expect((await revoke('wc-old')).status).toBe(202);
    });

    it('never touches a platform identity', async () => {
      await run(env.DB, "UPDATE signing_identities SET provenance = 'platform' WHERE id = 'wi-b'");
      await expectProblem(await revoke('wc-old'), 409, 'IDENTITY_PROTECTED');
    });

    it('needs a Polaris ID sign-in', async () => {
      const magic = await makeSession(fx, {
        userId: (await makeUser(fx)).id,
        roles: ['admin', 'user'],
        amr: 'magic_link',
      });
      await expectProblem(
        await revoke('wc-old', 'pass.test.wi-b', magic),
        403,
        'IDP_SIGN_IN_REQUIRED',
      );
      await expectProblem(await revoke('wc-old', 'pass.test.wi-b', member), 403, 'FORBIDDEN');
    });
  });
});

describe('GET /platform/apple-calls', () => {
  it('is for platform admins and reads the provisioner ledger', async () => {
    ledger = [
      {
        id: 1,
        callId: 'c',
        phase: 'end',
        method: 'createPassType',
        target: null,
        caller: null,
        status: 'ok',
        appleRequestId: 'secret',
        durationMs: 5,
        at: 9,
      },
    ];
    const res = await call('/api/v1/platform/apple-calls', admin);
    const body = (await res.json()) as { available: boolean; items: Record<string, unknown>[] };
    expect(body.available).toBe(true);
    expect(body.items[0]).not.toHaveProperty('appleRequestId');
    await expectProblem(await call('/api/v1/platform/apple-calls', member), 403, 'FORBIDDEN');
  });

  it('reads as unavailable without the binding', async () => {
    bindApple(undefined);
    const res = await call('/api/v1/platform/apple-calls', admin);
    expect(await res.json()).toEqual({ available: false, items: [] });
  });
});
