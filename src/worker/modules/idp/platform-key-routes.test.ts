// Platform-keys PK-2a: what a Platform key may do on the Polaris ID routes, who the audit names, retries by key, and
// the person-only routes (design section 2.3).
import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { MINTABLE_PLATFORM_SCOPES } from '../../../shared/contracts/api-keys.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first } from '../../platform/db.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { person } from './access-test-fixtures.ts';
import { byUserOf } from './actor.ts';
import { callerOf } from './ops-start.ts';
import { admin, f, installOpsRig, paused, rig, start } from './ops-test-fixtures.ts';

installOpsRig();

async function platformKey(scopes: string[]) {
  const key = await makeApiKey(f(), {
    orgId: null,
    kind: 'platform',
    scopes,
    expiresAt: rig.h.clock.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
  });
  return {
    id: key.id,
    headers: { ...key.headers, 'cf-connecting-ip': '198.51.100.7' },
  };
}
const all8 = () => platformKey([...MINTABLE_PLATFORM_SCOPES]);
const group = () => `k${f().ids.id().replaceAll('-', '').slice(0, 12)}`;
const audited = (target: string) =>
  all<{ actor_type: string; actor_id: string; org_id: string | null }>(
    rig.h.env.DB,
    'SELECT actor_type, actor_id, org_id FROM audit_log WHERE target_id = ?',
    [target],
  );

describe('person-only routes refuse a key holding every platform scope', () => {
  it('freeze, breaker clear, holds, remove-external and a real offboard', async () => {
    const key = await all8();
    const p = await paused();
    const routes: [string, string, unknown?][] = [
      ['POST', '/api/v1/platform/idp/freeze', { reason: 'testing' }],
      ['POST', '/api/v1/platform/idp/scim-breaker/clear'],
      ['DELETE', `/api/v1/users/${p.user.id}/holds/console`],
      ['POST', `/api/v1/users/${p.user.id}/roles/console/remove-external`],
      ['POST', `/api/v1/users/${p.user.id}/offboard`],
      ['POST', `/api/v1/users/${p.user.id}/offboard`, { dryRun: false }],
      ['POST', `/api/v1/users/${p.user.id}/offboard`, { dryRun: 'true' }],
    ];
    for (const [method, path, body] of routes)
      await expectProblem(await start(path, method, key.headers, body), 403, 'PERSON_REQUIRED');
    expect(rig.queue.jobs).toEqual([]);
    expect(await all(rig.h.env.DB, 'SELECT 1 FROM operations')).toEqual([]);
  });

  it('offboard with dryRun answers the plan to a key and changes nothing', async () => {
    const key = await all8();
    const p = await person(f(), { link: true });
    rig.idp.addAccount(p.subject, { class: 'linked' });
    const res = await start(`/api/v1/users/${p.id}/offboard`, 'POST', key.headers, {
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ plan: { userId: p.id }, operation: null });
    expect(await all(rig.h.env.DB, 'SELECT 1 FROM operations')).toEqual([]);
  });
});

describe('a Platform key on the routes that take one', () => {
  it('reads with platform:read, and refuses a write without its scope', async () => {
    const key = await platformKey(['platform:read']);
    expect((await start('/api/v1/platform/idp/groups', 'GET', key.headers)).status).toBe(200);
    expect((await start('/api/v1/platform/idp/drift', 'GET', key.headers)).status).toBe(200);
    await expectProblem(
      await start('/api/v1/platform/idp/groups', 'POST', key.headers, {
        key: group(),
        friendlyName: 'Crew',
      }),
      403,
      'MISSING_SCOPE',
    );
  });

  it('writes a group audited as the key, and a retry with the same Idempotency-Key does it once', async () => {
    const key = await platformKey(['platform:groups']);
    const name = group();
    const headers = { ...key.headers, 'idempotency-key': `once-${name}` };
    const first1 = await start('/api/v1/platform/idp/groups', 'POST', headers, {
      key: name,
      friendlyName: 'Crew',
    });
    expect(first1.status).toBe(201);
    const again = await start('/api/v1/platform/idp/groups', 'POST', headers, {
      key: name,
      friendlyName: 'Crew',
    });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await first1.json());
    expect(await audited(name)).toEqual([
      { actor_type: 'api_key', actor_id: key.id, org_id: null },
    ]);
    const row = await first<{ created_by: string }>(
      rig.h.env.DB,
      'SELECT created_by FROM idp_groups WHERE key = ?',
      [name],
    );
    const creator = await first<{ created_by: string }>(
      rig.h.env.DB,
      'SELECT created_by FROM api_keys WHERE id = ?',
      [key.id],
    );
    expect(row?.created_by).toBe(creator?.created_by);
  });

  it('refuses a key whose creator is no longer active', async () => {
    const key = await platformKey(['platform:groups']);
    await rig.h.env.DB.prepare(
      "UPDATE users SET status = 'disabled' WHERE id = (SELECT created_by FROM api_keys WHERE id = ?)",
    )
      .bind(key.id)
      .run();
    const res = await start('/api/v1/platform/idp/groups', 'POST', key.headers, {
      key: group(),
      friendlyName: 'Crew',
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
  });

  it('grants a platform role audited as the key, and never to a platform admin', async () => {
    const key = await platformKey(['platform:users']);
    const t = await person(f(), { link: true });
    rig.idp.addAccount(t.subject, { class: 'linked' });
    const res = await start(`/api/v1/users/${t.id}/roles`, 'POST', key.headers, {
      role: 'developer',
      grant: true,
    });
    expect(res.status).toBe(200);
    expect(await audited(t.id)).toEqual([
      { actor_type: 'api_key', actor_id: key.id, org_id: null },
    ]);
    const boss = await person(f(), { link: true, lastRoles: ['admin', 'user'] });
    await expectProblem(
      await start(`/api/v1/users/${boss.id}/roles`, 'POST', key.headers, {
        role: 'support',
        grant: true,
      }),
      409,
      'IDP_PLATFORM_ADMIN',
    );
  });

  it('never reaches a platform admin claims, and writes a user claims as the key', async () => {
    const key = await platformKey(['platform:claims']);
    const boss = await person(f(), { link: true, lastRoles: ['admin', 'user'] });
    rig.idp.addAccount(boss.subject, { class: 'created' });
    const set = { passbook_tier: { type: 'text', value: 'gold' } };
    await expectProblem(
      await start(`/api/v1/users/${boss.id}/claims`, 'PATCH', key.headers, { set }),
      409,
      'IDP_PLATFORM_ADMIN',
    );
    await expectProblem(
      await start(`/api/v1/users/${boss.id}/claims`, 'GET', key.headers),
      409,
      'IDP_PLATFORM_ADMIN',
    );
    const t = await person(f(), { link: true });
    rig.idp.addAccount(t.subject, { class: 'created' });
    expect(
      (await start(`/api/v1/users/${t.id}/claims`, 'PATCH', key.headers, { set })).status,
    ).toBe(200);
    expect((await audited(t.id)).every((r) => r.actor_id === key.id)).toBe(true);
  });

  it('starts a check as the key, and a retry with the same Idempotency-Key answers the same operation', async () => {
    const key = await platformKey(['platform:users']);
    const headers = { ...key.headers, 'idempotency-key': 'check-once' };
    const a = await start('/api/v1/platform/idp/reconcile', 'POST', headers, { dryRun: true });
    expect(a.status).toBe(202);
    const op = (await a.json()) as { operation: { id: string } };
    const b = await start('/api/v1/platform/idp/reconcile', 'POST', headers, { dryRun: true });
    expect(((await b.json()) as typeof op).operation.id).toBe(op.operation.id);
    const row = await first<{ actor_type: string; actor_id: string }>(
      rig.h.env.DB,
      'SELECT actor_type, actor_id FROM operations WHERE id = ?',
      [op.operation.id],
    );
    expect(row).toEqual({ actor_type: 'api_key', actor_id: key.id });
  });

  it('invites by key: the row names the key and the audit row too', async () => {
    const key = await platformKey(['platform:users']);
    const crew = group();
    await start(
      '/api/v1/platform/idp/groups',
      'POST',
      (await platformKey(['platform:groups'])).headers,
      {
        key: crew,
        friendlyName: 'Crew',
      },
    );
    const email = `inv-${crew}@agency.test`;
    const res = await start('/api/v1/platform/invitations', 'POST', key.headers, {
      email,
      groups: [crew],
    });
    expect(res.status).toBe(201);
    const row = await first<{
      id: string;
      created_by_user: string | null;
      created_by_key: string | null;
    }>(
      rig.h.env.DB,
      'SELECT id, created_by_user, created_by_key FROM platform_invitations WHERE email = ?',
      [email],
    );
    expect(row).toMatchObject({ created_by_user: null, created_by_key: key.id });
    expect(await audited(row?.id ?? '')).toEqual([
      { actor_type: 'api_key', actor_id: key.id, org_id: null },
    ]);
  });
});

describe('a service key and the person path', () => {
  it('a key of an org is refused on a key route, and a person still passes', async () => {
    const org = await makeApiKey(f());
    const res = await start('/api/v1/platform/idp/groups', 'GET', org.headers);
    expect(res.status).toBe(403);
    const a = await admin();
    expect((await start('/api/v1/platform/idp/groups', 'GET', a.headers)).status).toBe(200);
  });
});

describe('R2b fixes', () => {
  it('L1: a creator who lost the admin role writes no row, even past the gate', async () => {
    const key = await platformKey(['platform:groups']);
    const actor = {
      userId: null,
      keyId: key.id,
      actorType: 'api_key',
      actorId: key.id,
    } as never;
    await expect(byUserOf(rig.h.env.DB, actor)).resolves.toEqual(expect.any(String));
    await rig.h.env.DB.prepare(
      'UPDATE users SET last_roles = \'["user"]\' WHERE id = (SELECT created_by FROM api_keys WHERE id = ?)',
    )
      .bind(key.id)
      .run();
    await expect(byUserOf(rig.h.env.DB, actor)).rejects.toMatchObject({ status: 403 });
  });

  it('L2: a key reaching for a platform admin is reported as the key, ids only', async () => {
    const key = await platformKey(['platform:users']);
    const boss = await person(f(), { link: true, lastRoles: ['admin', 'user'] });
    const events: Record<string, unknown>[] = [];
    const app = createApp({
      stores: {
        sessions: createSessionStore(rig.h.env, rig.h.clock),
        apiKeys: createApiKeyStore(rig.h.env, rig.h.clock),
        scanners: denyAllStores.scanners,
        onDenied: (e) => {
          events.push({ ...e });
        },
      },
      clock: rig.h.clock,
    });
    const res = await app.request(
      `https://wallet.test/api/v1/users/${boss.id}/roles`,
      {
        method: 'POST',
        headers: { ...key.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'support', grant: true }),
      },
      rig.h.env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(409);
    expect(events).toMatchObject([
      { code: 'IDP_PLATFORM_ADMIN', actorType: 'api_key', actorId: key.id, platformKey: true },
    ]);
    expect(JSON.stringify(events)).not.toContain(boss.email);
  });

  it('L4: no principal is the stable unauthenticated error', () => {
    const c = { var: {} } as never;
    expect(() => callerOf(c)).toThrow(UnauthenticatedError);
  });
});
