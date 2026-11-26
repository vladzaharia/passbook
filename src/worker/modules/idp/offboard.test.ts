import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { removeFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import { makeApiKey, makeOrg, makeSession } from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { OffboardStartedSchema } from '../../../shared/contracts/idp-access.ts';
import { all, first, run } from '../../platform/db.ts';
import { membership, person, sponsor } from './access-test-fixtures.ts';
import { admin, f, installOpsRig, opOf, read, rig, runNext, start } from './ops-test-fixtures.ts';
import { insertGrant } from './repo-role-grants.ts';
import { recordApplied, recordObserved } from './repo-state.ts';

installOpsRig();

const offboard = (id: string) => `/api/v1/users/${id}/offboard`;

/** A linked user who is a member and sponsored developer of one org, holds a support grant and has a platform key. */
async function target() {
  const org = await makeOrg(f());
  const keeper = await person(f(), { link: false });
  await membership(f(), org.id, keeper, ['org_admin']);
  const p = await person(f(), { link: true });
  const membershipId = await membership(f(), org.id, p, ['org_admin']);
  const sponsorId = await sponsor(f(), org.id, p);
  const now = rig.h.clock.now();
  await insertGrant(rig.h.env.DB, {
    id: f().ids.id(),
    userId: p.id,
    role: 'support',
    grantedBy: p.id,
    now,
  });
  const key = await makeApiKey(f(), { orgId: null, kind: 'platform' });
  await withoutTrigger(rig.h.env.DB, 'api_keys_identity_immutable', () =>
    run(rig.h.env.DB, 'UPDATE api_keys SET created_by = ? WHERE id = ?', [p.id, key.id]),
  );
  const session = await makeSession(f(), { userId: p.id, roles: ['user'] });
  rig.idp.addAccount(p.subject, { class: 'linked', roles: ['console', 'developer', 'support'] });
  for (const role of ['console', 'developer', 'support'] as const)
    await recordApplied(rig.h.env.DB, {
      subject: p.subject,
      target: role,
      userId: p.id,
      observed: true,
      presence: 'passbook',
      now,
    });
  for (const role of ['console', 'developer', 'support'] as const)
    rig.idp.accounts.get(p.subject)?.grants.add(role);
  return { org, p, membershipId, sponsorId, key, session };
}

describe('offboard', () => {
  it('a dry run returns the plan and changes nothing', async () => {
    const t = await target();
    const a = await admin();
    const res = await start(offboard(t.p.id), 'POST', a.headers, { dryRun: true });
    expect(res.status).toBe(200);
    const body = OffboardStartedSchema.parse(await res.json());
    expect(body.operation).toBeNull();
    expect(body.plan).toMatchObject({
      userId: t.p.id,
      memberships: [{ membershipId: t.membershipId, orgId: t.org.id }],
      sponsorships: [{ orgId: t.org.id }],
      grants: ['support'],
      platformKeys: [t.key.id],
      sessions: 1,
      removes: ['console', 'developer', 'support'],
      external: [],
      blockers: [],
    });
    const user = await first<{ status: string }>(
      rig.h.env.DB,
      'SELECT status FROM users WHERE id = ?',
      [t.p.id],
    );
    expect(user?.status).toBe('active');
    expect(rig.queue.jobs).toEqual([]);
  });

  it('ends exactly what the dry run listed, then removes the roles in Polaris ID', async () => {
    const t = await target();
    const a = await admin();
    const dry = OffboardStartedSchema.parse(
      await (await start(offboard(t.p.id), 'POST', a.headers, { dryRun: true })).json(),
    );
    const res = await start(offboard(t.p.id), 'POST', a.headers, {});
    expect(res.status).toBe(202);
    const body = OffboardStartedSchema.parse(await res.clone().json());
    expect(body.plan).toEqual(dry.plan);
    const op = await opOf(res);
    expect(op).toMatchObject({ kind: 'idp.offboard', target: { type: 'user', id: t.p.id } });
    expect(res.headers.get('location')).toBe(`/api/v1/operations/${op.id}`);
    const db = rig.h.env.DB;
    const live = (sql: string, ...params: string[]) => first<{ n: number }>(db, sql, params);
    expect(
      (
        await live(
          'SELECT count(*) AS n FROM org_memberships WHERE user_id = ? AND revoked_at IS NULL',
          t.p.id,
        )
      )?.n,
    ).toBe(0);
    expect(
      (
        await live(
          'SELECT count(*) AS n FROM developer_sponsors WHERE user_id = ? AND ended_at IS NULL',
          t.p.id,
        )
      )?.n,
    ).toBe(0);
    expect(
      (
        await live(
          'SELECT count(*) AS n FROM platform_role_grants WHERE user_id = ? AND revoked_at IS NULL',
          t.p.id,
        )
      )?.n,
    ).toBe(0);
    expect(
      (
        await live(
          'SELECT count(*) AS n FROM api_keys WHERE id = ? AND revoked_at IS NULL',
          t.key.id,
        )
      )?.n,
    ).toBe(0);
    expect(
      (
        await live(
          'SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
          t.p.id,
        )
      )?.n,
    ).toBe(0);
    expect(
      (await live("SELECT count(*) AS n FROM users WHERE id = ? AND status = 'disabled'", t.p.id))
        ?.n,
    ).toBe(1);
    await runNext(op);
    const done = await read(op.id, a.headers);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.steps.map((s) => [s.key, s.state])).toEqual([
      ['revoke', 'done'],
      ['sync', 'done'],
      ['confirm', 'done'],
    ]);
    expect(done.result?.ids).toEqual({ external: '0' });
    expect([...(rig.idp.accounts.get(t.p.subject)?.roles ?? [])]).toEqual([]);
    const audit = await all<{ action: string }>(
      db,
      "SELECT action FROM audit_log WHERE target_id = ? AND action = 'idp.offboard'",
      [t.p.id],
    );
    expect(audit).toHaveLength(1);
  });

  it('lists a role added in Polaris ID and leaves it', async () => {
    const t = await target();
    rig.idp.accounts.get(t.p.subject)?.grants.delete('developer');
    await recordObserved(rig.h.env.DB, {
      subject: t.p.subject,
      target: 'developer',
      userId: t.p.id,
      observed: true,
      presence: 'external',
      now: rig.h.clock.now(),
    });
    const a = await admin();
    const dry = OffboardStartedSchema.parse(
      await (await start(offboard(t.p.id), 'POST', a.headers, { dryRun: true })).json(),
    );
    expect(dry.plan).toMatchObject({ removes: ['console', 'support'], external: ['developer'] });
    const op = await opOf(await start(offboard(t.p.id), 'POST', a.headers, {}));
    await runNext(op);
    const done = await read(op.id, a.headers);
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.result?.ids).toEqual({ external: '1' });
    expect(rig.idp.accounts.get(t.p.subject)?.roles.has('developer')).toBe(true);
  });

  it('refuses a platform admin (yourself too) and a last org admin, changing nothing', async () => {
    const a = await admin();
    const boss = await person(f(), { lastRoles: ['admin', 'user'] });
    await expectProblem(
      await start(offboard(boss.id), 'POST', a.headers, { dryRun: true }),
      409,
      'IDP_PLATFORM_ADMIN',
    );
    await expectProblem(
      await start(offboard(a.user.id), 'POST', a.headers, {}),
      409,
      'IDP_PLATFORM_ADMIN',
    );
    const org = await makeOrg(f());
    const lone = await person(f(), { link: true });
    await membership(f(), org.id, lone, ['org_admin']);
    const dry = OffboardStartedSchema.parse(
      await (await start(offboard(lone.id), 'POST', a.headers, { dryRun: true })).json(),
    );
    expect(dry.plan.blockers).toEqual([{ orgId: org.id, name: org.name, code: 'LAST_ORG_ADMIN' }]);
    await expectProblem(
      await start(offboard(lone.id), 'POST', a.headers, {}),
      409,
      'LAST_ORG_ADMIN',
    );
    const row = await first<{ status: string }>(
      rig.h.env.DB,
      'SELECT status FROM users WHERE id = ?',
      [lone.id],
    );
    expect(row?.status).toBe('active');
    expect(rig.queue.jobs).toEqual([]);
  });

  it('keeps a membership of an org that is not active and says so', async () => {
    const t = await target();
    const idle = await makeOrg(f());
    await run(rig.h.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [idle.id]);
    await membership(f(), idle.id, t.p, ['org_admin']);
    const a = await admin();
    const dry = OffboardStartedSchema.parse(
      await (await start(offboard(t.p.id), 'POST', a.headers, { dryRun: true })).json(),
    );
    expect(dry.plan.kept).toEqual([{ orgId: idle.id, name: idle.name }]);
    expect(dry.plan.memberships.map((m) => m.orgId)).toEqual([t.org.id]);
  });

  it('answers a repeat with the same key by the first operation', async () => {
    const t = await target();
    const a = await admin();
    const headers = { ...a.headers, 'idempotency-key': 'offboard-1' };
    const first1 = await opOf(await start(offboard(t.p.id), 'POST', headers, {}));
    const again = await opOf(await start(offboard(t.p.id), 'POST', headers, {}));
    expect(again.id).toBe(first1.id);
    expect(rig.queue.jobs.filter((j) => j.kind === 'operation.run')).toHaveLength(1);
  });

  it('needs the Polaris ID binding', async () => {
    const t = await target();
    const a = await admin();
    removeFakeIdp(rig.h.env);
    await expectProblem(
      await start(offboard(t.p.id), 'POST', a.headers, { dryRun: true }),
      503,
      'IDP_UNAVAILABLE',
    );
  });
});
