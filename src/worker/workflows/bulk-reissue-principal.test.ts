import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../test/helpers/index.ts';
import { createSessionStore } from '../modules/auth/sessions.ts';
import { jobCtxOf } from '../modules/delivery/delivery-test-fixtures.ts';
import { startBulkReissue } from '../modules/passes/bulk.ts';
import { reissuePage } from '../modules/passes/bulk-reissue-page.ts';
import { tenantAuthorityOf } from '../modules/passes/http.ts';
import { type Kit, setupKit } from '../modules/passes/pass-test-fixtures.ts';
import { insertWorkflowRun } from '../modules/passes/repo.ts';
import type { ReissuePrincipal } from '../modules/passes/repo-bulk-principal.ts';
import { RACE_PASS_PUBLISH } from '../modules/scan/race-tags.ts';
import { watchBatch } from '../modules/templates/testing.ts';
import { first, run } from '../platform/db.ts';
import { runBulkReissue } from './bulk-reissue.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const stepRun = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Parameters<typeof runBulkReissue>[3];

async function membership(roles: string[], orgId = kit.org.id) {
  const user = await makeUser(kit.fx);
  const invitationId = kit.fx.ids.id();
  const membershipId = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      JSON.stringify(roles),
      kit.fx.ids.token(),
      now,
      now + 3600_000,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, user.id, invitationId, JSON.stringify(roles), now],
  );
  const principal: ReissuePrincipal = {
    kind: 'membership',
    membershipId,
    userId: user.id,
    userAccessRevision: 1,
    orgAccessRevision: 1,
  };
  return { principal, userId: user.id, membershipId };
}

const params = (principal: ReissuePrincipal, orgId: string | null = kit.org.id) => ({
  templateId: null,
  version: null,
  orgId,
  mode: 'live' as const,
  cause: 'resign' as const,
  principal,
});

async function start(p: ReturnType<typeof params>) {
  const instanceId = `bulk-${kit.fx.ids.token(6)}`;
  await insertWorkflowRun(kit.env.DB, {
    instanceId,
    kind: 'bulk_reissue',
    orgId: p.orgId,
    targetId: instanceId,
    now: kit.clock.now(),
  });
  const totals = await runBulkReissue(kit.env, instanceId, p, stepRun);
  const row = await first<{ status: string; error_code: string | null }>(
    kit.env.DB,
    'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
    [instanceId],
  );
  return { totals, row };
}

const versionOf = async (id: string) =>
  (await first<{ version: number }>(kit.env.DB, 'SELECT version FROM passes WHERE id = ?', [id]))
    ?.version;

describe('bulk reissue re-checks the principal that started it', () => {
  it('runs while a pass operator still holds the right and stops once revoked', async () => {
    const created = await kit.pass();
    const m = await membership(['pass_operator']);
    const first1 = await start(params(m.principal));
    expect(first1.row).toEqual({ status: 'complete', error_code: null });
    expect(first1.totals.changed).toBe(1);
    const version = await versionOf(created.id);

    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      m.membershipId,
    ]);
    const second = await start(params(m.principal));
    expect(second.row).toEqual({ status: 'errored', error_code: 'REISSUE_PRINCIPAL_REVOKED' });
    expect(second.totals).toEqual({ changed: 0, unchanged: 0, failed: 0 });
    expect(await versionOf(created.id)).toBe(version);
  });

  it('stops for a member without passes:operate', async () => {
    const m = await membership(['integration_admin']);
    const { row } = await start(params(m.principal));
    expect(row?.error_code).toBe('REISSUE_PRINCIPAL_REVOKED');
  });

  it('stops when the user was disabled and re-enabled after the start', async () => {
    const m = await membership(['pass_operator']);
    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [m.userId]);
    await run(kit.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [m.userId]);
    const { row } = await start(params(m.principal));
    expect(row?.error_code).toBe('REISSUE_PRINCIPAL_REVOKED');
  });

  it('stops for a key that was revoked and for one without passes:write', async () => {
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const principal: ReissuePrincipal = {
      kind: 'api_key',
      keyId: key.id,
      keyOrgId: kit.org.id,
      mode: 'live',
      orgAccessRevision: 1,
    };
    expect((await start(params(principal))).row?.status).toBe('complete');
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      key.id,
    ]);
    expect((await start(params(principal))).row?.error_code).toBe('REISSUE_PRINCIPAL_REVOKED');
    const other = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['connections:write'] });
    expect((await start(params({ ...principal, keyId: other.id }))).row?.error_code).toBe(
      'REISSUE_PRINCIPAL_REVOKED',
    );
  });

  it('stops for a platform admin who no longer signs in as an admin', async () => {
    const user = await makeUser(kit.fx);
    await run(kit.env.DB, 'UPDATE users SET last_roles = \'["admin"]\' WHERE id = ?', [user.id]);
    const principal: ReissuePrincipal = {
      kind: 'platform',
      userId: user.id,
      userAccessRevision: 1,
    };
    expect((await start(params(principal, null))).row?.status).toBe('complete');
    await run(kit.env.DB, 'UPDATE users SET last_roles = \'["user"]\' WHERE id = ?', [user.id]);
    expect((await start(params(principal, null))).row?.error_code).toBe(
      'REISSUE_PRINCIPAL_REVOKED',
    );
  });

  it('re-checks on every page, not only the first', async () => {
    const m = await membership(['pass_operator']);
    const p = params(m.principal);
    expect((await reissuePage(kit.ctx, p, null)).revoked).toBeUndefined();
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      m.membershipId,
    ]);
    expect((await reissuePage(kit.ctx, p, null)).revoked).toBe(true);
  });

  it('stops the very next write when the starter is revoked mid-page', async () => {
    const created = [await kit.pass(), await kit.pass()];
    const m = await membership(['pass_operator']);
    const before = await Promise.all(created.map((p) => versionOf(p.id)));
    const watched = watchBatch(kit.env, RACE_PASS_PUBLISH, async () => {
      await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
        kit.clock.now(),
        m.membershipId,
      ]);
    });
    const ctx = jobCtxOf({ ctx: { ...kit.ctx, env: watched.env } });
    const page = await reissuePage(ctx, params(m.principal), null);
    expect(watched.fired()).toBe(1);
    expect(page.revoked).toBe(true);
    expect(page.changed).toBe(0);
    expect(await Promise.all(created.map((p) => versionOf(p.id)))).toEqual(before);
  });

  it('stops when the organization is suspended after the start', async () => {
    const other = await makeOrg(kit.fx);
    const m = await membership(['pass_operator'], other.id);
    expect(
      (await reissuePage(kit.ctx, params(m.principal, other.id), null)).revoked,
    ).toBeUndefined();
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [other.id]);
    expect((await reissuePage(kit.ctx, params(m.principal, other.id), null)).revoked).toBe(true);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [other.id]);
    // Reactivation moved the org's access revision: the run that began before it stays stopped.
    expect((await reissuePage(kit.ctx, params(m.principal, other.id), null)).revoked).toBe(true);
  });

  it('captures the real principal when a rebuild starts', async () => {
    const user = await makeUser(kit.fx);
    await run(kit.env.DB, 'UPDATE users SET last_roles = ? WHERE id = ?', ['["admin"]', user.id]);
    const invitationId = kit.fx.ids.id();
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, '["pass_operator"]', ?, ?, ?, ?)`,
      [invitationId, kit.org.id, user.primaryEmail, kit.fx.ids.token(), now, now + 3600_000, now],
    );
    const membershipId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, '["pass_operator"]', ?)`,
      [membershipId, kit.org.id, user.id, invitationId, now],
    );
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!session) throw new Error('The persisted session did not resolve');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'passes:operate');
    const system = { type: 'system', id: null } as const;

    await startBulkReissue(
      kit.ctx,
      system,
      { orgId: kit.org.id, cause: 'resign' },
      { authority, mode: 'live' },
    );
    const org = await first<{ access_revision: number }>(
      kit.env.DB,
      'SELECT access_revision FROM orgs WHERE id = ?',
      [kit.org.id],
    );
    const userRow = await first<{ access_revision: number }>(
      kit.env.DB,
      'SELECT access_revision FROM users WHERE id = ?',
      [user.id],
    );
    expect(kit.workflow.created.at(-1)?.params).toMatchObject({
      principal: {
        kind: 'membership',
        membershipId,
        userId: user.id,
        userAccessRevision: userRow?.access_revision,
        orgAccessRevision: org?.access_revision,
      },
    });

    await startBulkReissue(
      kit.ctx,
      system,
      { cause: 'resign', identityId: 'identity-for-test' },
      { platformSession: { userId: user.id, sessionId: session.sessionId }, mode: 'live' },
    );
    expect(kit.workflow.created.at(-1)?.params).toMatchObject({
      principal: {
        kind: 'platform',
        userId: user.id,
        userAccessRevision: userRow?.access_revision,
      },
    });
  });
});
