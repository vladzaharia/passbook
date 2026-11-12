import { describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  runOne,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { inviteOrgMember, revokeOrgInvitation, revokeOrgMembership } from './membership-service.ts';

async function setup() {
  const f = fixtures(await makeEnv());
  const ctx = createServiceContext(f.env, { clock: f.clock });
  const org = await makeOrg(f);
  const other = await makeOrg(f);
  const join = async (orgId: string, roles: OrgRole[], platform = false) => {
    const user = await makeUser(f);
    const invitationId = f.ids.id();
    const id = f.ids.id();
    const now = f.clock.now();
    await run(
      f.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invitationId,
        orgId,
        user.primaryEmail,
        JSON.stringify(roles),
        f.ids.token(),
        now,
        now + 1e6,
        now,
      ],
    );
    await run(
      f.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, orgId, user.id, invitationId, JSON.stringify(roles), now],
    );
    const session = await makeSession(f, {
      userId: user.id,
      roles: platform ? ['admin', 'user'] : ['user'],
    });
    const auth = await createSessionStore(f.env, f.clock).resolve(session.cookieValue);
    if (!auth) throw new Error('session fixture missing');
    return { user, id, session, auth };
  };
  const revokedAt = async (id: string) =>
    (
      await first<{ revoked_at: number | null }>(
        f.env.DB,
        'SELECT revoked_at FROM org_memberships WHERE id = ?',
        [id],
      )
    )?.revoked_at ?? null;
  return { f, ctx, org, other, join, revokedAt };
}

describe('membership grants: safety', () => {
  it('keeps the last org_admin, then lets the next one go once another exists', async () => {
    const t = await setup();
    const a = await t.join(t.org.id, ['org_admin']);
    const b = await t.join(t.org.id, ['org_admin']);
    await revokeOrgMembership(t.ctx, a.auth, t.org.id, b.id);
    await expect(revokeOrgMembership(t.ctx, a.auth, t.org.id, a.id)).rejects.toMatchObject({
      status: 409,
      code: 'LAST_ORG_ADMIN',
    });
    expect(await t.revokedAt(a.id)).toBeNull();
    const c = await t.join(t.org.id, ['org_admin']);
    await revokeOrgMembership(t.ctx, c.auth, t.org.id, a.id);
    expect(await t.revokedAt(a.id)).not.toBeNull();
  });

  it('keeps the last org_admin even for a platform admin', async () => {
    const t = await setup();
    const sole = await t.join(t.org.id, ['org_admin']);
    const admin = await t.join(t.other.id, ['read_only'], true);
    await expect(revokeOrgMembership(t.ctx, admin.auth, t.org.id, sole.id)).rejects.toMatchObject({
      code: 'LAST_ORG_ADMIN',
    });
    expect(await t.revokedAt(sole.id)).toBeNull();
  });

  it('does not let one org’s manager revoke or invite into another', async () => {
    const t = await setup();
    const mine = await t.join(t.org.id, ['org_admin']);
    const theirs = await t.join(t.other.id, ['org_admin']);
    const spare = await t.join(t.other.id, ['pass_operator']);
    await expect(revokeOrgMembership(t.ctx, mine.auth, t.other.id, spare.id)).rejects.toMatchObject(
      {
        status: 403,
      },
    );
    // Naming the manager's own org with another org's membership changes nothing.
    await expect(revokeOrgMembership(t.ctx, mine.auth, t.org.id, spare.id)).rejects.toMatchObject({
      code: 'MEMBERSHIP_CONFLICT',
    });
    expect(await t.revokedAt(spare.id)).toBeNull();
    expect(await t.revokedAt(theirs.id)).toBeNull();
  });

  it.each(['session revoked', 'membership revoked', 'org suspended'] as const)(
    'refuses a revoke when the manager’s %s before commit, writing nothing',
    async (change) => {
      const t = await setup();
      const manager = await t.join(t.org.id, ['org_admin']);
      const spare = await t.join(t.org.id, ['pass_operator']);
      const audits = () => all(t.f.env.DB, "SELECT id FROM audit_log WHERE action LIKE 'org_%'");
      const before = await audits();
      // The checks run inside the grant, so the change lands after the service's own read but the
      // revoke batch still refuses it.
      if (change === 'session revoked')
        await runOne(t.f.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [
          t.f.clock.now(),
          manager.user.id,
        ]);
      else if (change === 'membership revoked')
        await runOne(t.f.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          t.f.clock.now(),
          manager.id,
        ]);
      else
        await runOne(t.f.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [t.org.id]);
      await expect(
        revokeOrgMembership(t.ctx, manager.auth, t.org.id, spare.id),
      ).rejects.toBeDefined();
      expect(await t.revokedAt(spare.id)).toBeNull();
      expect(await audits()).toEqual(before);
    },
  );

  it('invites and uninvites atomically with their audit rows, and refuses a stale revoke', async () => {
    const t = await setup();
    const manager = await t.join(t.org.id, ['org_admin']);
    const invited = await inviteOrgMember(t.ctx, manager.auth, t.org.id, {
      email: `new-${t.f.ids.id()}@example.test`,
      roles: ['read_only'],
    }).catch(() => null);
    // The mailer binding is a test double; either way the invitation row and its audit commit together.
    const rows = await all<{ id: string }>(
      t.f.env.DB,
      'SELECT id FROM org_invitations WHERE org_id = ?',
      [t.org.id],
    );
    const created = rows.find((r) => r.id !== undefined && invited?.id === r.id) ?? rows.at(-1);
    if (!created) throw new Error('invitation missing');
    expect(
      await all(
        t.f.env.DB,
        "SELECT action FROM audit_log WHERE target_id = ? AND action = 'org_invitation.create'",
        [created.id],
      ),
    ).toHaveLength(1);
    await revokeOrgInvitation(t.ctx, manager.auth, t.org.id, created.id);
    await expect(
      revokeOrgInvitation(t.ctx, manager.auth, t.org.id, created.id),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_CONFLICT',
    });
    expect(
      await all(
        t.f.env.DB,
        "SELECT action FROM audit_log WHERE target_id = ? AND action = 'org_invitation.revoke'",
        [created.id],
      ),
    ).toHaveLength(1);
  });
});

describe('membership grants: liveness', () => {
  it('revokes after an org settings save, which is not authority', async () => {
    const t = await setup();
    const manager = await t.join(t.org.id, ['org_admin']);
    const spare = await t.join(t.org.id, ['pass_operator']);
    await runOne(t.f.env.DB, "UPDATE orgs SET name = 'Renamed' WHERE id = ?", [t.org.id]);
    await revokeOrgMembership(t.ctx, manager.auth, t.org.id, spare.id);
    expect(await t.revokedAt(spare.id)).not.toBeNull();
  });
});
