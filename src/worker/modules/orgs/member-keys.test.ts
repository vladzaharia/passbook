import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import * as kit from '../api-keys/test-kit.ts';
import { f, h, member, org } from '../api-keys/test-kit.ts';
import * as repo from './repo-members.ts';

const DAY = 86_400_000;
beforeEach(kit.setup);
afterEach(() => {
  vi.restoreAllMocks();
  kit.teardown();
});

const key = (scopes: string[], options: { orgId?: string; mode?: 'live' | 'test' } = {}) =>
  makeApiKey(f(), {
    orgId: options.orgId ?? org.id,
    scopes,
    ...(options.mode ? { mode: options.mode } : {}),
    expiresAt: h.clock.now() + 30 * DAY,
  });
const writer = () => key(['members:write']);
const base = (orgId = org.id) => `/api/v1/orgs/${orgId}`;
const invite = (headers: Record<string, string>, roles: string[], email = 'new@a.test') =>
  h.call(`${base()}/invitations`, { method: 'POST', headers, json: { email, roles } });
const resend = (headers: Record<string, string>, id: string) =>
  h.call(`${base()}/invitations/${id}/resend`, { method: 'POST', headers });
const patch = (headers: Record<string, string>, id: string, roles: string[]) =>
  h.call(`${base()}/memberships/${id}`, { method: 'PATCH', headers, json: { roles } });
const revokeMember = (headers: Record<string, string>, id: string) =>
  h.call(`${base()}/memberships/${id}`, { method: 'DELETE', headers });
/** A pending invitation row, as a person would have made it. */
async function seedInvitation(roles: string[], email: string) {
  const id = f().ids.id();
  const now = h.clock.now();
  await run(
    h.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, org.id, email, JSON.stringify(roles), f().ids.token(), now, now + 7 * DAY],
  );
  return id;
}
const rolesOf = (id: string) =>
  first<{ roles: string; revoked_at: number | null }>(
    h.env.DB,
    'SELECT roles, revoked_at FROM org_memberships WHERE id = ?',
    [id],
  );

describe('invitations by key', () => {
  it('invites a pass_operator, audited as the key, the mail naming the org', async () => {
    const k = await writer();
    const res = await invite(k.headers, ['pass_operator']);
    expect(res.status).toBe(201);
    const audit = await first<{ actor_type: string; actor_id: string; detail: string }>(
      h.env.DB,
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'org_invitation.create' AND org_id = ?",
      [org.id],
    );
    expect(audit).toMatchObject({ actor_type: 'api_key', actor_id: k.id });
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ via: 'api' });
    expect(h.mail[0]?.text).toContain(`${org.name} invited you to ${org.name}`);
  });

  it('refuses an administering role and writes nothing', async () => {
    const k = await writer();
    for (const roles of [['org_admin'], ['pass_operator', 'integration_admin']])
      await expectProblem(await invite(k.headers, roles), 403, 'KEY_CANNOT_ADMINISTER');
    expect(
      await first(h.env.DB, 'SELECT 1 AS n FROM org_invitations WHERE org_id = ?', [org.id]),
    ).toBeNull();
  });

  it('resends an operator invitation and refuses an admin one', async () => {
    const k = await writer();
    const operator = await seedInvitation(['pass_operator'], 'op@a.test');
    const admin = await seedInvitation(['org_admin'], 'ad@a.test');
    expect((await resend(k.headers, operator)).status).toBe(201);
    await expectProblem(await resend(k.headers, admin), 403, 'KEY_CANNOT_ADMINISTER');
  });

  it('withdraws an invitation of any roles', async () => {
    const k = await writer();
    const admin = await seedInvitation(['org_admin'], 'ad@a.test');
    const res = await h.call(`${base()}/invitations/${admin}`, {
      method: 'DELETE',
      headers: k.headers,
    });
    expect(res.status).toBe(200);
  });
});

describe('memberships by key', () => {
  it('changes pass_operator to read_only, and never to or from an administering role', async () => {
    const k = await writer();
    const operator = await member('pass_operator');
    const admin = await member('org_admin');
    expect((await patch(k.headers, operator.membershipId, ['read_only'])).status).toBe(200);
    expect(
      JSON.parse(
        (
          await first<{ roles: string }>(
            h.env.DB,
            'SELECT roles FROM org_memberships WHERE org_id = ? AND revoked_at IS NULL AND roles = \'["read_only"]\'',
            [org.id],
          )
        )?.roles ?? '[]',
      ),
    ).toEqual(['read_only']);
    const other = await member('read_only');
    await expectProblem(
      await patch(k.headers, other.membershipId, ['org_admin']),
      403,
      'KEY_CANNOT_ADMINISTER',
    );
    await expectProblem(
      await patch(k.headers, admin.membershipId, ['read_only']),
      403,
      'KEY_CANNOT_ADMINISTER',
    );
    expect((await rolesOf(admin.membershipId))?.revoked_at).toBeNull();
    expect((await rolesOf(other.membershipId))?.revoked_at).toBeNull();
  });

  it('revokes an operator and refuses an admin', async () => {
    const k = await writer();
    const operator = await member('pass_operator');
    const admin = await member('org_admin');
    expect((await revokeMember(k.headers, operator.membershipId)).status).toBe(200);
    expect((await rolesOf(operator.membershipId))?.revoked_at).not.toBeNull();
    await expectProblem(
      await revokeMember(k.headers, admin.membershipId),
      403,
      'KEY_CANNOT_ADMINISTER',
    );
    expect((await rolesOf(admin.membershipId))?.revoked_at).toBeNull();
  });

  it('leaves a member promoted between the read and the write', async () => {
    const k = await writer();
    const target = await member('org_admin');
    await member('org_admin');
    // The read saw an operator; the row it was written against is an admin by the time the write lands.
    const real = repo.activeMembershipById;
    vi.spyOn(repo, 'activeMembershipById').mockImplementation(async (...args) => {
      const row = await real(...args);
      return row && { ...row, roles: JSON.stringify(['pass_operator']) };
    });
    await expectProblem(
      await revokeMember(k.headers, target.membershipId),
      409,
      'MEMBERSHIP_CONFLICT',
    );
    expect((await rolesOf(target.membershipId))?.revoked_at).toBeNull();
  });
});

describe('who gets in', () => {
  it('lists with members:read, which cannot write', async () => {
    const k = await key(['members:read']);
    await member('pass_operator');
    await seedInvitation(['read_only'], 'p@a.test');
    const members = (await (
      await h.call(`${base()}/memberships`, { headers: k.headers })
    ).json()) as {
      items: unknown[];
    };
    expect(members.items).toHaveLength(1);
    const invitations = (await (
      await h.call(`${base()}/invitations`, { headers: k.headers })
    ).json()) as { items: { email: string }[] };
    expect(invitations.items.map((i) => i.email)).toContain('p@a.test');
    await expectProblem(await invite(k.headers, ['read_only']), 403, 'MISSING_SCOPE');
  });

  it('refuses a Test key, another org, and a platform key', async () => {
    const test = await key(['members:write'], { mode: 'test' });
    expect((await invite(test.headers, ['read_only'])).status).toBe(403);
    const elsewhere = await key(['members:write'], { orgId: kit.other.id });
    expect((await invite(elsewhere.headers, ['read_only'])).status).toBe(403);
    const platform = await makeApiKey(f(), {
      orgId: null,
      scopes: ['platform:users'],
      expiresAt: h.clock.now() + 30 * DAY,
      ipAllow: ['203.0.113.7'],
    });
    expect([401, 403]).toContain((await invite(platform.headers, ['read_only'])).status);
    expect(
      await first(h.env.DB, 'SELECT 1 AS n FROM org_invitations WHERE org_id = ?', [org.id]),
    ).toBeNull();
  });

  it('never reaches the invitee and own-account routes', async () => {
    const k = await writer();
    const res = await h.call('/api/v1/orgs/memberships/me', { headers: k.headers });
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});
