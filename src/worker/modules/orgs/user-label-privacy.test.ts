// A tenant never reads another user's account email (users.primary_email): it sees the user's name, else
// the email its own org invited them by, else "Account". Only a platform administrator sees the primary.
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtures, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';
import { lastVoidEvent } from '../passes/repo-devices.ts';
import { userNames } from '../templates/repo-release-names.ts';
import { orgMembers } from './repo-members.ts';

let h: TestHarness;
let orgId: string;
let otherOrgId: string;
let managerId: string;
let memberId: string;
let strangerId: string;
const primary = 'account-owner@example.test';
const alias = 'invited-as@example.test';

async function member(userId: string, org: string, email: string, role: string) {
  const fx = fixtures(h.env, h.clock);
  const invitationId = fx.ids.id();
  const now = h.clock.now();
  const roles = JSON.stringify([role]);
  await run(
    h.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [invitationId, org, email, roles, fx.ids.token(), now, now + 3600_000, now],
  );
  await run(
    h.env.DB,
    'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [fx.ids.id(), org, userId, invitationId, roles, now],
  );
}

beforeAll(async () => {
  h = await harness();
  const fx = fixtures(h.env, h.clock);
  orgId = (await makeOrg(fx)).id;
  otherOrgId = (await makeOrg(fx)).id;
  managerId = (await makeUser(fx)).id;
  // The account's primary email differs from the alias this org invited it by.
  memberId = (await makeUser(fx, { primaryEmail: primary })).id;
  strangerId = (await makeUser(fx)).id;
  await member(managerId, orgId, 'manager@example.test', 'org_admin');
  await member(memberId, orgId, alias, 'read_only');
  await member(strangerId, otherOrgId, 'stranger-invite@example.test', 'read_only');
});

describe('userNames', () => {
  it('uses the name, else the email the org knows, else Account; a platform admin sees the primary', async () => {
    const ids = [memberId, strangerId];
    const tenant = await userNames(h.env.DB, ids, orgId, false);
    expect(tenant.get(memberId)).toBe(alias);
    expect(tenant.get(strangerId)).toBe('Account');
    expect([...tenant.values()].join()).not.toContain(primary);
    expect((await userNames(h.env.DB, ids, null, false)).get(memberId)).toBe('Account');
    expect((await userNames(h.env.DB, ids, orgId, true)).get(memberId)).toBe(primary);
    await run(h.env.DB, 'UPDATE users SET name = ? WHERE id = ?', ['Ada', memberId]);
    expect((await userNames(h.env.DB, ids, orgId, false)).get(memberId)).toBe('Ada');
    await run(h.env.DB, 'UPDATE users SET name = NULL WHERE id = ?', [memberId]);
  });
});

describe('member list', () => {
  it('shows the invited email to org managers and the account email to a platform admin', async () => {
    const tenant = await orgMembers(h.env.DB, orgId, managerId, false);
    expect(tenant.find((m) => m.user_id === memberId)?.user_email).toBe(alias);
    expect(JSON.stringify(tenant)).not.toContain(primary);
    const admin = await orgMembers(h.env.DB, orgId, managerId, true);
    expect(admin.find((m) => m.user_id === memberId)?.user_email).toBe(primary);
  });
});

describe('void actor label', () => {
  it('labels the voiding user without the account email for tenants', async () => {
    await run(
      h.env.DB,
      `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES (?, ?, 'user', ?, 'pass.void', 'pass', 'pass-void-label')`,
      [h.clock.now(), orgId, memberId],
    );
    expect((await lastVoidEvent(h.env.DB, 'pass-void-label', false))?.actorLabel).toBe(alias);
    expect((await lastVoidEvent(h.env.DB, 'pass-void-label', true))?.actorLabel).toBe(primary);
  });
});
