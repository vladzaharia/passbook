import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { fakeAuth, makeApiKey, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { SetupStatusSchema } from '../../../shared/contracts/idp-setup.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { all, run } from '../../platform/db.ts';
import { buildOpenApiDocument } from '../../platform/openapi-document.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { operationRunners } from './operations.ts';
import { f } from './ops-test-fixtures.ts';
import {
  admin,
  installSetupRig,
  opOf,
  read,
  rig,
  runNext,
  SETUP,
  setupOnce,
  start,
} from './setup-test-fixtures.ts';

installSetupRig();

/** An org key is no Platform key. */
const NOT_A_PLATFORM_KEY = ['PLATFORM_KEY_REQUIRED', 'MISSING_SCOPE'];

const matrix = async (headers: Record<string, string>) =>
  SetupStatusSchema.parse(await (await rig.h.call(SETUP, { headers })).json());
const itemOf = async (headers: Record<string, string>, key: string) =>
  (await matrix(headers)).items.find((i) => i.key === key);

describe('the item matrix', () => {
  it('starts with groups needed and everything behind them waiting', async () => {
    const a = await admin();
    const { items, mode } = await matrix(a.headers);
    expect(mode).toBe('live');
    expect(items.map((i) => [i.key, i.status, i.reason])).toEqual([
      ['binding', 'done', undefined],
      ['polaris_settings', 'done', undefined],
      ['client', 'done', undefined],
      ['groups', 'needed', undefined],
      ['client_groups', 'needed', 'after:groups'],
      ['client_restricted', 'needed', 'after:client_groups'],
      ['client_logo', 'needed', 'after:client_restricted'],
      ['scim_token', 'needed', 'after:client_restricted'],
      ['scim_provider', 'needed', 'after:client_restricted'],
      ['scim_sync', 'needed', 'after:scim_provider'],
      ['scim_mirror', 'needed', 'after:scim_sync'],
      ['write_mode', 'done', undefined],
    ]);
  });

  it('reads client_groups as needed while an existing alias is not allowed', async () => {
    rig.idp.groupStore.set('support', {
      kind: 'role',
      name: 'passbook_support',
      friendlyName: 'passbook_support',
      otherClients: 0,
    });
    for (const g of ['console', 'developer', 'support', 'platform_admin'])
      rig.idp.setup.client.allowed.add(g);
    const a = await admin();
    // No alias group in Polaris ID: nothing to show or allow.
    const none = await itemOf(a.headers, 'client_groups');
    expect(none).toMatchObject({ status: 'done' });
    expect(none?.rows?.map((r) => r.key)).not.toContain('wallet_org_admins');
    rig.idp.setup.alias.exists = true;
    const before = await itemOf(a.headers, 'client_groups');
    expect(before).toMatchObject({ status: 'needed', counts: { missing: 1 } });
    expect(before?.rows).toContainEqual({ key: 'wallet_org_admins', state: 'needed' });
    rig.idp.setup.client.allowed.add('alias:wallet_org_admins');
    const after = await itemOf(a.headers, 'client_groups');
    expect(after).toMatchObject({ status: 'done' });
    expect(after?.rows).toContainEqual({ key: 'wallet_org_admins', state: 'allowed' });
    expect((await itemOf(a.headers, 'groups'))?.rows?.map((r) => r.key)).not.toContain(
      'wallet_org_admins',
    );
  });

  it('blocks with a reason and an owner flag, and the rest waits', async () => {
    rig.idp.setup.client.found = false;
    const a = await admin();
    const items = (await matrix(a.headers)).items;
    expect(items.find((i) => i.key === 'client')).toMatchObject({
      status: 'blocked',
      reason: 'client_not_found',
      owner: true,
    });
    expect(items.find((i) => i.key === 'groups')).toMatchObject({ reason: 'after:client' });
  });

  it('reports a binding that is not there, refused or frozen as the first item', async () => {
    const a = await admin();
    rig.idp.frozen = true;
    expect((await itemOf(a.headers, 'binding'))?.reason).toBe('frozen');
    rig.idp.frozen = false;
    rig.idp.failNext('IDP_AUTH', 'health');
    expect(await itemOf(a.headers, 'binding')).toMatchObject({
      status: 'blocked',
      reason: 'idp_auth',
      owner: true,
    });
    rig.idp.failNext('IDP_UPSTREAM', 'health');
    expect(await itemOf(a.headers, 'binding')).toMatchObject({ reason: 'binding_unreachable' });
  });

  it('is for platform admins only', async () => {
    const key = await makeApiKey(f());
    expect((await rig.h.call(SETUP, { headers: {} })).status).toBe(401);
    await expectProblem(await rig.h.call(SETUP, { headers: key.headers }), 403, NOT_A_PLATFORM_KEY);
    await expectProblem(
      await rig.h.call(SETUP, { headers: (await admin(['user'])).headers }),
      403,
      'FORBIDDEN',
    );
  });
});

describe('start', () => {
  it('needs a platform admin signed in with Polaris ID, recently', async () => {
    const key = await makeApiKey(f());
    for (const path of [SETUP, '/api/v1/platform/idp/scim-token/rotate']) {
      expect((await start(path, 'POST', {})).status).toBe(401);
      await expectProblem(await start(path, 'POST', key.headers), 403, NOT_A_PLATFORM_KEY);
      await expectProblem(
        await start(path, 'POST', (await admin(['user'])).headers),
        403,
        'FORBIDDEN',
      );
      await expectProblem(
        await start(path, 'POST', (await admin(['admin', 'user'], 'magic_link')).headers),
        403,
        'IDP_SIGN_IN_REQUIRED',
      );
      const user = await makeUser(f());
      const old = await makeSession(f(), {
        userId: user.id,
        roles: ['admin', 'user'],
        authTime: rig.h.clock.now() - 3 * 3600_000,
      });
      await expectProblem(await start(path, 'POST', old.headers, {}), 403, 'STEP_UP_REQUIRED');
    }
    expect(rig.queue.jobs).toEqual([]);
  });

  it('is a dry run by default and refuses a body it does not know', async () => {
    const a = await admin();
    const op = await opOf(await start(SETUP, 'POST', a.headers));
    expect(op).toMatchObject({ kind: 'idp.setup', target: { type: 'idp_setup', id: 'dry' } });
    await run(rig.h.env.DB, 'DELETE FROM operations');
    expect((await start(SETUP, 'POST', a.headers, { dryRun: 'no' })).status).toBe(422);
    expect((await start(SETUP, 'POST', a.headers, { items: ['binding'] })).status).toBe(422);
    expect((await start(SETUP, 'POST', a.headers, { dryRun: false, extra: 1 })).status).toBe(422);
  });

  it('answers a repeated Idempotency-Key with the first operation, and a changed body with 409', async () => {
    const a = await admin();
    const headers = { ...a.headers, 'idempotency-key': 'setup-1' };
    const first = await opOf(await start(SETUP, 'POST', headers, { dryRun: false }));
    expect((await opOf(await start(SETUP, 'POST', headers, { dryRun: false }))).id).toBe(first.id);
    await expectProblem(
      await start(SETUP, 'POST', headers, { dryRun: true }),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('is one setup or rotation at a time', async () => {
    const a = await admin();
    await opOf(await start(SETUP, 'POST', a.headers));
    await expectProblem(
      await start('/api/v1/platform/idp/scim-token/rotate', 'POST', a.headers),
      409,
      'OPERATION_RUNNING',
    );
  });

  it('is not retryable by a Workbench token or a key', async () => {
    const a = await admin();
    rig.idp.setup.client.found = false;
    const op = await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    await runNext(op);
    const key = await makeApiKey(f());
    const res = await start(`/api/v1/operations/${op.id}/retry`, 'POST', key.headers);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await read(op.id, a.headers)).attempt).toBe(1);
  });
});

describe('a Platform key', () => {
  const platformKey = async (scopes: string[]) => {
    const key = await makeApiKey(f(), {
      orgId: null,
      kind: 'platform',
      scopes,
      expiresAt: rig.h.clock.now() + 30 * 86_400_000,
      ipAllow: ['198.51.100.0/24'],
    });
    return { id: key.id, headers: { ...key.headers, 'cf-connecting-ip': '198.51.100.7' } };
  };

  it('needs platform:settings to start and platform:status or platform:read to read, and no step-up', async () => {
    const reader = await platformKey(['platform:read']);
    expect((await rig.h.call(SETUP, { headers: reader.headers })).status).toBe(200);
    const status = await platformKey(['platform:status']);
    expect((await rig.h.call(SETUP, { headers: status.headers })).status).toBe(200);
    await expectProblem(
      await start(SETUP, 'POST', reader.headers, { dryRun: false }),
      403,
      'MISSING_SCOPE',
    );
    const writer = await platformKey(['platform:settings']);
    const op = await opOf(await start(SETUP, 'POST', writer.headers, {}));
    expect(op.startedBy).toEqual({ type: 'api_key', id: writer.id });
    await runNext(op);
    expect((await read(op.id, writer.headers)).status).toBe('succeeded');
  });

  it('runs a live setup, audited as the key, and stops when the key is revoked', async () => {
    const writer = await platformKey(['platform:settings']);
    const op = await opOf(await start(SETUP, 'POST', writer.headers, { dryRun: false }));
    await run(rig.h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      rig.h.clock.now(),
      writer.id,
    ]);
    await runNext(op);
    const rows = await all<{ actor_type: string }>(
      rig.h.env.DB,
      "SELECT actor_type FROM audit_log WHERE action = 'idp.setup'",
    );
    expect(rows).toEqual([{ actor_type: 'api_key' }]);
    expect(rig.idp.writes).toBe(0);
  });

  it('records every item row as the key, with the operation id', async () => {
    const writer = await platformKey(['platform:settings']);
    const actors: unknown[] = [];
    const real = rig.idp.placeRoleGroups.bind(rig.idp);
    rig.idp.placeRoleGroups = async (ctx) => {
      actors.push(ctx.actor);
      return real(ctx);
    };
    const op = await opOf(await start(SETUP, 'POST', writer.headers, { dryRun: false }));
    await runNext(op);
    expect(actors).toEqual([{ kind: 'key', id: writer.id }]);
    const rows = await all<{
      action: string;
      actor_type: string;
      actor_id: string;
      detail: string;
    }>(
      rig.h.env.DB,
      "SELECT action, actor_type, actor_id, detail FROM audit_log WHERE action LIKE 'idp.setup.%' AND actor_type = 'api_key' AND actor_id = ?",
      [writer.id],
    );
    const all2 = await all<{ n: number }>(
      rig.h.env.DB,
      "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'idp.setup.%'",
    );
    expect(rows.length).toBeGreaterThan(3);
    expect(all2[0]?.n).toBe(rows.length);
    for (const r of rows) expect(JSON.parse(r.detail).operationId).toBe(op.id);
  });

  it('stops a run whose key loses platform:settings between steps', async () => {
    const writer = await platformKey(['platform:settings']);
    const real = rig.idp.placeRoleGroups.bind(rig.idp);
    rig.idp.placeRoleGroups = async (ctx) => {
      const out = await real(ctx);
      // The scopes are immutable in practice: lift the trigger to model a future change.
      await withoutTrigger(rig.h.env.DB, 'api_keys_identity_immutable', () =>
        run(rig.h.env.DB, `UPDATE api_keys SET scopes = '["platform:read"]' WHERE id = ?`, [
          writer.id,
        ]),
      );
      return out;
    };
    const op = await opOf(await start(SETUP, 'POST', writer.headers, { dryRun: false }));
    await runNext(op);
    expect((await read(op.id, writer.headers)).error?.code).toBe('IDP_ADMIN_ENDED');
    expect(rig.idp.setup.client.restricted).toBe(false);
  });

  it('cannot retry', async () => {
    const writer = await platformKey(['platform:settings']);
    rig.idp.setup.client.found = false;
    const op = await opOf(await start(SETUP, 'POST', writer.headers, { dryRun: false }));
    await runNext(op);
    expect(
      (await start(`/api/v1/operations/${op.id}/retry`, 'POST', writer.headers)).status,
    ).toBeGreaterThanOrEqual(400);
  });
});

describe('route scopes', () => {
  it('GET /idp/setup declares platform:status', async () => {
    const doc = buildOpenApiDocument(createApp({ stores: fakeAuth().stores })) as {
      paths: Record<string, { get?: Record<string, unknown> }>;
    };
    expect(doc.paths['/api/v1/platform/idp/setup']?.get?.['x-platform-scope']).toBe(
      'platform:status',
    );
  });
});

describe('retry', () => {
  it('refuses a Workbench token even when it stands for an admin', async () => {
    const ctx = createJobContext(rig.h.env, 'test', { clock: rig.h.clock });
    const op = { error: { code: 'IDP_SETUP_TOKEN' } } as unknown as OperationDto;
    const caller = {
      kind: 'session',
      roles: ['admin', 'user'],
      amr: 'oidc',
      workbench: { orgId: 'o', subject: 'member' },
    } as unknown as SessionAuth;
    for (const kind of ['idp.setup', 'idp.scim_rotate'])
      await expect(operationRunners[kind]?.authorizeRetry?.(ctx, op, caller)).rejects.toMatchObject(
        {
          code: 'IDP_SIGN_IN_REQUIRED',
        },
      );
  });
});

describe('audit', () => {
  it('a preview writes no audit row; a live start writes one without ids', async () => {
    const a = await admin();
    await setupOnce({}, a.headers);
    expect(
      await all(rig.h.env.DB, "SELECT id FROM audit_log WHERE action LIKE 'idp.setup%'"),
    ).toEqual([]);
    await run(rig.h.env.DB, 'DELETE FROM operations');
    await opOf(await start(SETUP, 'POST', a.headers, { dryRun: false }));
    const rows = await all<{ action: string; detail: string | null }>(
      rig.h.env.DB,
      "SELECT action, detail FROM audit_log WHERE action = 'idp.setup'",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ dryRun: false });
  });
});
