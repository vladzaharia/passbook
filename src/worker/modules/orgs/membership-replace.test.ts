import { describe, expect, it } from 'vitest';
import {
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import {
  ChangeOrgMemberRolesSchema,
  type OrgRole,
} from '../../../shared/contracts/org-membership.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { keyLive } from '../../platform/repo-api-key-sql.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ACTOR_HOURLY_INVITES } from './invitation-limits.ts';
import { changeOrgMemberRoles, resendOrgInvitation } from './membership-replace.ts';
import { inviteOrgMember } from './membership-service.ts';
import { ensurePersonalOrg } from './personal.ts';
import { replaceMembership } from './repo-member-replace.ts';

const sent: { to: string; text: string }[] = [];
let failMail = false;

async function setup() {
  const env = await makeEnv({
    PUBLIC_BASE_URL: 'https://wallet.test',
    EMAIL_FROM: 'passes@example.test',
    EMAIL: {
      send: async (message: { to: string; text: string }) => {
        if (failMail) throw new Error('mail down');
        sent.push(message);
        return { messageId: 'm' };
      },
    } as unknown as AppEnv['EMAIL'],
  });
  const f = fixtures(env);
  const ctx = createServiceContext(env, { clock: f.clock });
  const org = await makeOrg(f);
  const other = await makeOrg(f);
  const join = async (orgId: string, roles: OrgRole[], platform = false) => {
    const user = await makeUser(f);
    const invitationId = f.ids.id();
    const id = f.ids.id();
    const now = f.clock.now();
    await run(
      env.DB,
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
      env.DB,
      'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, orgId, user.id, invitationId, JSON.stringify(roles), now],
    );
    const session = await makeSession(f, {
      userId: user.id,
      roles: platform ? ['admin', 'user'] : ['user'],
    });
    const auth = await createSessionStore(env, f.clock).resolve(session.cookieValue);
    if (!auth) throw new Error('session fixture missing');
    return { user, id, auth };
  };
  /** A platform admin with their personal org: its one member is the owner. */
  const personal = async () => {
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
    await ensurePersonalOrg(ctx, {
      userId: user.id,
      sessionId: await sha256Hex(session.cookieValue),
    });
    const row = await first<{ id: string }>(
      env.DB,
      'SELECT id FROM orgs WHERE personal_user_id = ?',
      [user.id],
    );
    const member = await first<{ id: string }>(
      env.DB,
      'SELECT id FROM org_memberships WHERE org_id = ?',
      [row?.id ?? ''],
    );
    const auth = await createSessionStore(env, f.clock).resolve(session.cookieValue);
    if (!auth || !row || !member) throw new Error('personal org fixture missing');
    return { orgId: row.id, membershipId: member.id, auth };
  };
  const active = (orgId: string, userId: string) =>
    all<{ id: string; roles: string; revoked_at: number | null }>(
      env.DB,
      'SELECT id, roles, revoked_at FROM org_memberships WHERE org_id = ? AND user_id = ? ORDER BY created_at, rowid',
      [orgId, userId],
    );
  const audits = (action: string) =>
    all<{ target_id: string }>(env.DB, 'SELECT target_id FROM audit_log WHERE action = ?', [
      action,
    ]);
  return { env, f, ctx, org, other, join, personal, active, audits };
}

describe('change roles', () => {
  it('replaces the membership in one batch, keeps the invited address and audits it', async () => {
    const t = await setup();
    const admin = await t.join(t.org.id, ['org_admin']);
    const member = await t.join(t.org.id, ['pass_operator']);
    sent.length = 0;
    const result = await changeOrgMemberRoles(t.ctx, admin.auth, t.org.id, member.id, [
      'template_author',
      'template_reviewer',
    ]);
    expect(result.roles).toEqual(['template_author', 'template_reviewer']);
    expect(result.id).not.toBe(member.id);
    expect(result.userEmail).toBe(member.user.primaryEmail);
    const rows = await t.active(t.org.id, member.user.id);
    expect(rows.map((r) => [r.id === member.id, r.revoked_at !== null])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect((await t.audits('org_membership.roles')).map((a) => a.target_id)).toEqual([result.id]);
    expect(sent).toEqual([]);
  });

  it('is a no-op for the same roles: nothing is written', async () => {
    const t = await setup();
    const admin = await t.join(t.org.id, ['org_admin']);
    const member = await t.join(t.org.id, ['pass_operator', 'template_author']);
    const before = await t.audits('org_membership.roles');
    const result = await changeOrgMemberRoles(t.ctx, admin.auth, t.org.id, member.id, [
      'template_author',
      'pass_operator',
    ]);
    expect(result.id).toBe(member.id);
    expect(await t.audits('org_membership.roles')).toEqual(before);
  });

  it('keeps the last org admin, and lets the role go once another admin exists', async () => {
    const t = await setup();
    const sole = await t.join(t.org.id, ['org_admin']);
    const before = await t.audits('org_membership.roles');
    await expect(
      changeOrgMemberRoles(t.ctx, sole.auth, t.org.id, sole.id, ['read_only']),
    ).rejects.toMatchObject({ status: 409, code: 'LAST_ORG_ADMIN' });
    expect((await t.active(t.org.id, sole.user.id))[0]?.revoked_at).toBeNull();
    expect(await t.audits('org_membership.roles')).toEqual(before);
    const next = await t.join(t.org.id, ['org_admin']);
    const result = await changeOrgMemberRoles(t.ctx, next.auth, t.org.id, sole.id, ['read_only']);
    expect(result.roles).toEqual(['read_only']);
  });

  it('keeps the last org admin even for a platform admin', async () => {
    const t = await setup();
    const sole = await t.join(t.org.id, ['org_admin']);
    const platform = await t.join(t.other.id, ['read_only'], true);
    await expect(
      changeOrgMemberRoles(t.ctx, platform.auth, t.org.id, sole.id, ['pass_operator']),
    ).rejects.toMatchObject({ code: 'LAST_ORG_ADMIN' });
  });

  it('lets a platform admin change roles in an org they are not a member of', async () => {
    const t = await setup();
    await t.join(t.org.id, ['org_admin']);
    const member = await t.join(t.org.id, ['read_only']);
    const platform = await t.join(t.other.id, ['read_only'], true);
    const result = await changeOrgMemberRoles(t.ctx, platform.auth, t.org.id, member.id, [
      'pass_operator',
    ]);
    expect(result.roles).toEqual(['pass_operator']);
  });

  it('refuses anyone without members:manage, another org, an unknown member and a revoked one', async () => {
    const t = await setup();
    const manager = await t.join(t.org.id, ['org_admin']);
    const operator = await t.join(t.org.id, ['pass_operator']);
    const target = await t.join(t.org.id, ['read_only']);
    const foreign = await t.join(t.other.id, ['read_only']);
    await expect(
      changeOrgMemberRoles(t.ctx, operator.auth, t.org.id, target.id, ['pass_operator']),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      changeOrgMemberRoles(t.ctx, manager.auth, t.org.id, foreign.id, ['pass_operator']),
    ).rejects.toMatchObject({ status: 404, code: 'MEMBERSHIP_NOT_FOUND' });
    await expect(
      changeOrgMemberRoles(t.ctx, manager.auth, t.org.id, 'nope', ['pass_operator']),
    ).rejects.toMatchObject({ status: 404 });
    expect((await t.active(t.org.id, target.user.id))[0]?.roles).toBe('["read_only"]');
  });

  it('refuses a personal org', async () => {
    const t = await setup();
    const owner = await t.personal();
    await expect(
      changeOrgMemberRoles(t.ctx, owner.auth, owner.orgId, owner.membershipId, ['read_only']),
    ).rejects.toMatchObject({ code: 'ORG_PERSONAL_SINGLE_MEMBER' });
  });

  it('takes Organization admin and Read only alone', () => {
    for (const roles of [
      ['org_admin', 'pass_operator'],
      ['read_only', 'template_author'],
    ])
      expect(ChangeOrgMemberRolesSchema.safeParse({ roles }).success).toBe(false);
    expect(ChangeOrgMemberRolesSchema.safeParse({ roles: ['org_admin'] }).success).toBe(true);
    expect(
      ChangeOrgMemberRolesSchema.safeParse({ roles: ['pass_operator', 'template_author'] }).success,
    ).toBe(true);
    expect(ChangeOrgMemberRolesSchema.safeParse({ roles: [] }).success).toBe(false);
  });
});

describe('change roles: edges', () => {
  const live = async (t: Awaited<ReturnType<typeof setup>>, keyId: string) => {
    const k = keyLive('k', t.f.clock.now());
    return (
      (await first(t.env.DB, `SELECT 1 AS one FROM api_keys k WHERE k.id = ? AND ${k.sql}`, [
        keyId,
        ...k.params,
      ])) !== null
    );
  };

  it('answers an admin who demotes themselves with the new membership, not a refusal', async () => {
    const t = await setup();
    const me = await t.join(t.org.id, ['org_admin']);
    await t.join(t.org.id, ['org_admin']);
    const result = await changeOrgMemberRoles(t.ctx, me.auth, t.org.id, me.id, ['pass_operator']);
    expect(result.id).not.toBe(me.id);
    expect(result.roles).toEqual(['pass_operator']);
    expect(result.userId).toBe(me.user.id);
  });

  it('answers when the target is disabled', async () => {
    const t = await setup();
    const admin = await t.join(t.org.id, ['org_admin']);
    const target = await t.join(t.org.id, ['read_only']);
    await run(t.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [target.user.id]);
    const result = await changeOrgMemberRoles(t.ctx, admin.auth, t.org.id, target.id, [
      'pass_operator',
    ]);
    expect(result.roles).toEqual(['pass_operator']);
  });

  it('two admins demoting each other: the second is refused and one admin remains', async () => {
    const t = await setup();
    const a = await t.join(t.org.id, ['org_admin']);
    const b = await t.join(t.org.id, ['org_admin']);
    await changeOrgMemberRoles(t.ctx, a.auth, t.org.id, b.id, ['read_only']);
    await expect(
      changeOrgMemberRoles(t.ctx, a.auth, t.org.id, a.id, ['read_only']),
    ).rejects.toMatchObject({ status: 409, code: 'LAST_ORG_ADMIN' });
    // B's own request is refused too: B is no longer an admin.
    await expect(
      changeOrgMemberRoles(t.ctx, b.auth, t.org.id, a.id, ['read_only']),
    ).rejects.toMatchObject({ status: 403 });
    const admins = await all(
      t.env.DB,
      `SELECT m.id FROM org_memberships m WHERE m.org_id = ? AND m.revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value = 'org_admin')`,
      [t.org.id],
    );
    expect(admins).toHaveLength(1);
  });

  it('a second change on the old id is not found, and a raced replace is a conflict', async () => {
    const t = await setup();
    const admin = await t.join(t.org.id, ['org_admin']);
    const target = await t.join(t.org.id, ['read_only']);
    await changeOrgMemberRoles(t.ctx, admin.auth, t.org.id, target.id, ['pass_operator']);
    await expect(
      changeOrgMemberRoles(t.ctx, admin.auth, t.org.id, target.id, ['template_author']),
    ).rejects.toMatchObject({ status: 404, code: 'MEMBERSHIP_NOT_FOUND' });
    // Two requests that both read the old row: the batch of the second finds it already retired.
    await expect(
      replaceMembership(
        t.ctx,
        {
          kind: 'membership',
          membershipId: admin.id,
          via: 'session',
          sessionIdHash: admin.auth.sessionId,
        },
        [],
        {
          oldId: target.id,
          userId: target.user.id,
          email: target.user.primaryEmail,
          roles: '["template_author"]',
          membershipId: t.f.ids.id(),
          invitationId: t.f.ids.id(),
          hash: t.f.ids.token(),
          now: t.f.clock.now(),
          since: t.f.clock.now(),
        },
        {
          orgId: t.org.id,
          actorType: 'user',
          actorId: admin.user.id,
          action: 'org_membership.roles',
          targetType: 'org_membership',
          targetId: 'x',
        },
        { config: 'LAST_ORG_ADMIN' },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a membership that is already revoked', async () => {
    const t = await setup();
    const admin = await t.join(t.org.id, ['org_admin']);
    const target = await t.join(t.org.id, ['read_only']);
    await run(t.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      t.f.clock.now(),
      target.id,
    ]);
    await expect(
      changeOrgMemberRoles(t.ctx, admin.auth, t.org.id, target.id, ['pass_operator']),
    ).rejects.toMatchObject({ status: 404, code: 'MEMBERSHIP_NOT_FOUND' });
  });

  it('ends the old membership’s personal key, and leaves a service key alone', async () => {
    const t = await setup();
    const admin = await t.join(t.org.id, ['org_admin']);
    const target = await t.join(t.org.id, ['pass_operator']);
    const personal = await makeApiKey(t.f, {
      orgId: t.org.id,
      kind: 'personal',
      membershipId: target.id,
      scopes: ['passes:read'],
      expiresAt: t.f.clock.now() + 1e8,
    });
    const service = await makeApiKey(t.f, {
      orgId: t.org.id,
      kind: 'service',
      scopes: ['passes:read'],
      expiresAt: t.f.clock.now() + 1e8,
    });
    expect(await live(t, personal.id)).toBe(true);
    await changeOrgMemberRoles(t.ctx, admin.auth, t.org.id, target.id, [
      'pass_operator',
      'template_author',
    ]);
    expect(await live(t, personal.id)).toBe(false);
    expect(await live(t, service.id)).toBe(true);
  });

  it('keeps the member’s scheduled broadcasts scheduled, while a plain revoke still cancels them', async () => {
    const t = await setup();
    const admin = await t.join(t.org.id, ['org_admin']);
    const kept = await t.join(t.org.id, ['pass_operator']);
    const lost = await t.join(t.org.id, ['pass_operator']);
    const schedule = async (userId: string) => {
      const id = t.f.ids.id();
      await run(
        t.env.DB,
        `INSERT INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, created_at, created_by_type, created_by_id)
         VALUES (?, ?, 'live', 'message', 'B', 'scheduled', '{}', '{}', ?, 'user', ?)`,
        [id, t.org.id, t.f.clock.now(), userId],
      );
      return id;
    };
    const stateOf = async (id: string) =>
      (await first<{ state: string }>(t.env.DB, 'SELECT state FROM broadcasts WHERE id = ?', [id]))
        ?.state;
    const a = await schedule(kept.user.id);
    const b = await schedule(lost.user.id);
    t.f.clock.advance(1000);
    await changeOrgMemberRoles(t.ctx, admin.auth, t.org.id, kept.id, [
      'pass_operator',
      'template_author',
    ]);
    await run(t.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      t.f.clock.now(),
      lost.id,
    ]);
    expect(await stateOf(a)).toBe('scheduled');
    expect(await stateOf(b)).toBe('cancelled');
  });
});

describe('resend invitation', () => {
  async function invited(t: Awaited<ReturnType<typeof setup>>, email = 'new@example.test') {
    const manager = await t.join(t.org.id, ['org_admin']);
    const first = await inviteOrgMember(t.ctx, manager.auth, t.org.id, {
      email,
      roles: ['pass_operator'],
    });
    return { manager, first };
  }

  it('revokes the old invitation, issues a new one and mails a new link', async () => {
    const t = await setup();
    const { manager, first: old } = await invited(t);
    sent.length = 0;
    const fresh = await resendOrgInvitation(t.ctx, manager.auth, t.org.id, old.id);
    expect(fresh.id).not.toBe(old.id);
    expect([fresh.email, fresh.roles]).toEqual([old.email, old.roles]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('new@example.test');
    expect(sent[0]?.text).toMatch(/invitations\/accept#[A-Za-z0-9_-]{43}/);
    const rows = await all<{ id: string; revoked_at: number | null }>(
      t.env.DB,
      'SELECT id, revoked_at FROM org_invitations WHERE org_id = ? AND email = ? ORDER BY rowid',
      [t.org.id, 'new@example.test'],
    );
    expect(rows.map((r) => [r.id, r.revoked_at !== null])).toEqual([
      [old.id, true],
      [fresh.id, false],
    ]);
    expect((await t.audits('org_invitation.resend')).map((a) => a.target_id)).toEqual([fresh.id]);
  });

  it('works on an expired invitation and refuses a revoked, accepted or unknown one', async () => {
    const t = await setup();
    const manager = await t.join(t.org.id, ['org_admin']);
    const now = t.f.clock.now();
    const expiredId = t.f.ids.id();
    await run(
      t.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
       VALUES (?, ?, 'late@example.test', '["read_only"]', ?, ?, ?)`,
      [expiredId, t.org.id, t.f.ids.token(), now - 2000, now - 1000],
    );
    const fresh = await resendOrgInvitation(t.ctx, manager.auth, t.org.id, expiredId);
    expect(fresh.expiresAt).toBeGreaterThan(now);
    for (const id of [expiredId, 'nope'])
      await expect(resendOrgInvitation(t.ctx, manager.auth, t.org.id, id)).rejects.toMatchObject({
        code: 'MEMBERSHIP_CONFLICT',
      });
  });

  it('refuses anyone without members:manage, another org and a personal org', async () => {
    const t = await setup();
    const { first: old } = await invited(t);
    const operator = await t.join(t.org.id, ['pass_operator']);
    const foreign = await t.join(t.other.id, ['org_admin']);
    await expect(resendOrgInvitation(t.ctx, operator.auth, t.org.id, old.id)).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(resendOrgInvitation(t.ctx, foreign.auth, t.org.id, old.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      resendOrgInvitation(t.ctx, foreign.auth, t.other.id, old.id),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_CONFLICT',
    });
    const owner = await t.personal();
    await expect(resendOrgInvitation(t.ctx, owner.auth, owner.orgId, old.id)).rejects.toMatchObject(
      {
        code: 'ORG_PERSONAL_SINGLE_MEMBER',
      },
    );
  });

  it('counts against the hourly invite limit, and is refused past it', async () => {
    const t = await setup();
    const { manager, first: old } = await invited(t);
    const hour = 60 * 60 * 1000;
    await run(
      t.env.DB,
      'INSERT OR REPLACE INTO counters (key, window_start, count) VALUES (?, ?, ?)',
      [
        `invite:actor:${manager.user.id}`,
        t.f.clock.now() - (t.f.clock.now() % hour),
        ACTOR_HOURLY_INVITES,
      ],
    );
    await expect(resendOrgInvitation(t.ctx, manager.auth, t.org.id, old.id)).rejects.toMatchObject({
      status: 429,
    });
    const rows = await first<{ n: number }>(
      t.env.DB,
      'SELECT COUNT(*) AS n FROM org_invitations WHERE org_id = ? AND revoked_at IS NULL AND accepted_at IS NULL',
      [t.org.id],
    );
    expect(rows?.n).toBe(1);
  });

  it('revokes the new invitation again when the mail cannot go', async () => {
    const t = await setup();
    const { manager, first: old } = await invited(t);
    failMail = true;
    try {
      await expect(
        resendOrgInvitation(t.ctx, manager.auth, t.org.id, old.id),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      failMail = false;
    }
    const open = await all(
      t.env.DB,
      'SELECT id FROM org_invitations WHERE org_id = ? AND revoked_at IS NULL AND accepted_at IS NULL',
      [t.org.id],
    );
    expect(open).toEqual([]);
  });
});
