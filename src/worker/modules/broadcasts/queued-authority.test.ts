import { describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  runOne,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createJobContext, createServiceContext } from '../../platform/service-context.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { deleteOrg, setOrgStatus, updateOrg } from '../orgs/service.ts';
import { setUserStatus } from '../users/service.ts';
import { insertBroadcastStmt } from './repo.ts';
import { sendStepAllowed } from './run.ts';
import { startDueBroadcasts } from './start.ts';

async function setup() {
  const f = fixtures(await makeEnv());
  const ctx = createServiceContext(f.env, { clock: f.clock });
  const db = f.env.DB;
  const admin = await makeUser(f);
  const adminSession = await makeSession(f, { userId: admin.id, roles: ['admin', 'user'] });
  const adminSessionId = await hashSessionCookie(adminSession.cookieValue);
  const queue = async (
    orgId: string,
    createdBy: { type: string; id: string | null },
    state: 'draft' | 'scheduled' = 'scheduled',
    due = true,
  ) => {
    const id = f.ids.id();
    await insertBroadcastStmt(db, {
      id,
      orgId,
      mode: 'live',
      kind: 'message',
      name: 'Queued',
      state,
      target: {},
      patch: { message: 'hi' },
      notify: true,
      at: f.clock.now() + (due ? -1 : 3_600_000),
      clearAfter: null,
      actor: createdBy,
      now: f.clock.now(),
    }).run();
    return id;
  };
  const state = async (id: string) =>
    (await first<{ state: string; error_code: string | null }>(
      db,
      'SELECT state, error_code FROM broadcasts WHERE id = ?',
      [id],
    )) ?? { state: 'missing', error_code: null };
  return { f, ctx, db, admin, adminSessionId, queue, state };
}

describe('queued work and revocation (owner answers 2, 3 and 9)', () => {
  it('cancels a disabled user’s scheduled broadcasts, and they stay cancelled when the user is enabled again', async () => {
    const t = await setup();
    const org = await makeOrg(t.f);
    const other = await makeOrg(t.f);
    const user = await makeUser(t.f);
    const colleague = await makeUser(t.f);
    const mine = await t.queue(org.id, { type: 'user', id: user.id });
    const mineDraft = await t.queue(org.id, { type: 'user', id: user.id }, 'draft');
    const theirs = await t.queue(org.id, { type: 'user', id: colleague.id }, 'scheduled', false);
    const foreignSystem = await t.queue(other.id, { type: 'system', id: null }, 'scheduled', false);

    await setUserStatus(t.ctx, t.admin.id, user.id, 'disabled', t.adminSessionId);
    expect(await t.state(mine)).toEqual({ state: 'cancelled', error_code: 'CREATOR_REVOKED' });
    // A draft is not queued work, and nobody else's work is touched.
    expect((await t.state(mineDraft)).state).toBe('draft');
    expect((await t.state(theirs)).state).toBe('scheduled');
    expect((await t.state(foreignSystem)).state).toBe('scheduled');

    await setUserStatus(t.ctx, t.admin.id, user.id, 'active', t.adminSessionId);
    expect((await t.state(mine)).state).toBe('cancelled');
    await startDueBroadcasts(t.ctx);
    expect((await t.state(mine)).state).toBe('cancelled');
  });

  it('cancels scheduled broadcasts through the ungated service path too', async () => {
    const t = await setup();
    const org = await makeOrg(t.f);
    const user = await makeUser(t.f);
    const mine = await t.queue(org.id, { type: 'user', id: user.id });
    await setUserStatus(t.ctx, t.admin.id, user.id, 'disabled');
    expect((await t.state(mine)).state).toBe('cancelled');
  });

  it('refuses a disable from a revoked admin session and changes nothing', async () => {
    const t = await setup();
    const org = await makeOrg(t.f);
    const user = await makeUser(t.f);
    const mine = await t.queue(org.id, { type: 'user', id: user.id });
    await runOne(t.db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      t.f.clock.now(),
      t.adminSessionId,
    ]);
    await expect(
      setUserStatus(t.ctx, t.admin.id, user.id, 'disabled', t.adminSessionId),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect((await t.state(mine)).state).toBe('scheduled');
    expect(
      (await first<{ status: string }>(t.db, 'SELECT status FROM users WHERE id = ?', [user.id]))
        ?.status,
    ).toBe('active');
  });

  it('refuses a disable from a session without the admin role', async () => {
    const t = await setup();
    const user = await makeUser(t.f);
    const plain = await makeUser(t.f);
    const session = await makeSession(t.f, { userId: plain.id, roles: ['user'] });
    await expect(
      setUserStatus(
        t.ctx,
        plain.id,
        user.id,
        'disabled',
        await hashSessionCookie(session.cookieValue),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await first<{ status: string }>(t.db, 'SELECT status FROM users WHERE id = ?', [user.id]))
        ?.status,
    ).toBe('active');
  });

  it('cancels an org’s scheduled broadcasts on suspension and never revives them on reactivation', async () => {
    const t = await setup();
    const org = await makeOrg(t.f);
    const other = await makeOrg(t.f);
    const user = await makeUser(t.f);
    const queued = await t.queue(org.id, { type: 'user', id: user.id });
    const system = await t.queue(org.id, { type: 'system', id: null });
    const draft = await t.queue(org.id, { type: 'user', id: user.id }, 'draft');
    const foreign = await t.queue(other.id, { type: 'user', id: user.id });

    await setOrgStatus(t.ctx, { type: 'user', id: t.admin.id }, org.id, 'suspended');
    expect(await t.state(queued)).toEqual({ state: 'cancelled', error_code: 'ORG_INACTIVE' });
    expect((await t.state(system)).state).toBe('cancelled');
    expect((await t.state(draft)).state).toBe('draft');
    expect((await t.state(foreign)).state).toBe('scheduled');

    await setOrgStatus(t.ctx, { type: 'user', id: t.admin.id }, org.id, 'active');
    expect((await t.state(queued)).state).toBe('cancelled');
    expect((await t.state(system)).state).toBe('cancelled');
  });
});

describe('cancel triggers cover every path (one mechanism)', () => {
  it('cancels on a raw disable, a PATCH suspension, a delete and a membership revoke', async () => {
    const t = await setup();
    const org = await makeOrg(t.f);
    const user = await makeUser(t.f);
    const raw = await t.queue(org.id, { type: 'user', id: user.id });
    await runOne(t.db, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect(await t.state(raw)).toEqual({ state: 'cancelled', error_code: 'CREATOR_REVOKED' });

    const patched = await t.queue(org.id, { type: 'system', id: null });
    await updateOrg(t.ctx, { type: 'user', id: t.admin.id }, org.id, { status: 'suspended' });
    expect(await t.state(patched)).toEqual({ state: 'cancelled', error_code: 'ORG_INACTIVE' });

    const doomed = await makeOrg(t.f);
    const gone = await t.queue(doomed.id, { type: 'system', id: null });
    await deleteOrg(t.ctx, { type: 'user', id: t.admin.id }, doomed.id);
    expect(await t.state(gone)).toEqual({ state: 'cancelled', error_code: 'ORG_INACTIVE' });
  });

  it('cancels a revoked creator’s scheduled broadcasts in that org only', async () => {
    const t = await setup();
    const org = await makeOrg(t.f);
    const other = await makeOrg(t.f);
    const user = await makeUser(t.f);
    const join = async (orgId: string) => {
      const invitationId = t.f.ids.id();
      const id = t.f.ids.id();
      const now = t.f.clock.now();
      await run(
        t.db,
        `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
         VALUES (?, ?, ?, '["pass_operator"]', ?, ?, ?, ?)`,
        [invitationId, orgId, `${id}@example.test`, t.f.ids.token(), now, now + 1e6, now],
      );
      await run(
        t.db,
        `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
         VALUES (?, ?, ?, ?, '["pass_operator"]', ?)`,
        [id, orgId, user.id, invitationId, now],
      );
      return id;
    };
    const membership = await join(org.id);
    await join(other.id);
    const mine = await t.queue(org.id, { type: 'user', id: user.id }, 'scheduled', false);
    const elsewhere = await t.queue(other.id, { type: 'user', id: user.id }, 'scheduled', false);
    await runOne(t.db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      t.f.clock.now(),
      membership,
    ]);
    expect((await t.state(mine)).state).toBe('cancelled');
    expect((await t.state(elsewhere)).state).toBe('scheduled');
    // Re-inviting the creator does not bring it back.
    await join(org.id);
    expect((await t.state(mine)).state).toBe('cancelled');
  });
});

describe('send step gate (jobGrant)', () => {
  const sending = async (t: Awaited<ReturnType<typeof setup>>, orgId: string, userId: string) => {
    const id = await t.queue(orgId, { type: 'user', id: userId });
    await runOne(t.db, "UPDATE broadcasts SET state = 'sending' WHERE id = ?", [id]);
    return id;
  };
  const member = async (t: Awaited<ReturnType<typeof setup>>, orgId: string, userId: string) => {
    const invitationId = t.f.ids.id();
    const now = t.f.clock.now();
    await run(
      t.db,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, '["pass_operator"]', ?, ?, ?, ?)`,
      [
        invitationId,
        orgId,
        `${invitationId}@example.test`,
        t.f.ids.token(),
        now - 1,
        now + 1e6,
        now - 1,
      ],
    );
    const id = t.f.ids.id();
    await run(
      t.db,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, '["pass_operator"]', ?)`,
      [id, orgId, userId, invitationId, now - 1],
    );
    return id;
  };

  it('lets a live creator send and stops a revoked, re-invited or inactive one', async () => {
    const t = await setup();
    const job = createJobContext(t.f.env, 'test', { clock: t.f.clock });
    const org = await makeOrg(t.f);
    const user = await makeUser(t.f);
    const m = await member(t, org.id, user.id);
    const live = await sending(t, org.id, user.id);
    expect(await sendStepAllowed(job, live)).toBe(true);
    expect((await t.state(live)).state).toBe('sending');

    // Revoking and re-inviting: the new membership is newer than the broadcast.
    await runOne(t.db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      t.f.clock.now(),
      m,
    ]);
    await run(t.db, "UPDATE broadcasts SET state = 'sending' WHERE id = ?", [live]);
    t.f.clock.advance(10);
    const newer = t.f.clock.now();
    await run(
      t.db,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       SELECT ?, org_id, user_id, invitation_id, roles, ? FROM org_memberships WHERE id = ?`,
      [t.f.ids.id(), newer, m],
    ).catch(() => undefined);
    expect(await sendStepAllowed(job, live)).toBe(false);
    expect(await t.state(live)).toEqual({ state: 'failed', error_code: 'CREATOR_REVOKED' });

    const other = await makeOrg(t.f);
    const u2 = await makeUser(t.f);
    await member(t, other.id, u2.id);
    const inactive = await sending(t, other.id, u2.id);
    await runOne(t.db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [other.id]);
    await run(t.db, "UPDATE broadcasts SET state = 'sending' WHERE id = ?", [inactive]);
    expect(await sendStepAllowed(job, inactive)).toBe(false);
    expect(await t.state(inactive)).toEqual({ state: 'failed', error_code: 'ORG_INACTIVE' });
  });
});
