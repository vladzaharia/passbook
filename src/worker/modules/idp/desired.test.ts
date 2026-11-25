import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import {
  claim,
  db,
  developerInvitation,
  group,
  insert,
  membership,
  orgInvitation,
  person,
  personalOrg,
  platformInvitation,
  rule,
  sandboxOrg,
  sponsor,
  standardOrg,
  world,
} from './access-test-fixtures.ts';
import { desiredState, targetKeys } from './desired.ts';
import { insertGrant } from './repo-role-grants.ts';

const f = await world();
const now = f.clock.now();
const wants = async (subject: string, at = now) => {
  const d = await desiredState(db(), subject, at);
  return { d, targets: targetKeys(d) };
};

describe('desired state: console', () => {
  it('follows live memberships in active or suspended orgs, sandboxes included', async () => {
    const org = await standardOrg(f);
    const sandbox = await sandboxOrg(f);
    const p = await person(f);
    expect((await wants(p.subject)).targets).toEqual([]);
    const m = await membership(f, org.id, p);
    const { d, targets } = await wants(p.subject);
    expect(targets).toEqual(['console']);
    expect(d.targets.get('console')).toEqual([{ kind: 'membership', orgId: org.id }]);
    await run(db(), 'UPDATE orgs SET status = ? WHERE id = ?', ['suspended', org.id]);
    expect((await wants(p.subject)).targets).toEqual(['console']);
    await run(db(), 'UPDATE orgs SET status = ? WHERE id = ?', ['deleted', org.id]);
    expect((await wants(p.subject)).targets).toEqual([]);
    await run(db(), 'UPDATE orgs SET status = ? WHERE id = ?', ['active', org.id]);
    await run(db(), 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [now, m]);
    expect((await wants(p.subject)).targets).toEqual([]);
    await membership(f, sandbox.id, p);
    expect((await wants(p.subject)).targets).toEqual(['console']);
  });

  it('gives one reason per live membership, so a second org keeps the role after the first ends', async () => {
    const a = await standardOrg(f);
    const b = await standardOrg(f);
    const p = await person(f);
    const ma = await membership(f, a.id, p);
    await membership(f, b.id, p, ['read_only']);
    expect((await wants(p.subject)).d.targets.get('console')).toHaveLength(2);
    await run(db(), 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [now, ma]);
    expect((await wants(p.subject)).d.targets.get('console')).toEqual([
      { kind: 'membership', orgId: b.id },
    ]);
  });

  it('never counts a personal org', async () => {
    const p = await person(f);
    await personalOrg(f, p);
    expect((await wants(p.subject)).targets).toEqual([]);
  });
});

describe('desired state: developer and support', () => {
  it('wants developer while a sponsorship or a platform grant is live', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    const s = await sponsor(f, org.id, p);
    const first = await wants(p.subject);
    expect(first.d.targets.get('developer')).toEqual([{ kind: 'sponsorship', orgId: org.id }]);
    await insertGrant(db(), {
      id: f.ids.id(),
      userId: p.id,
      role: 'developer',
      grantedBy: p.id,
      now,
    });
    expect((await wants(p.subject)).d.targets.get('developer')).toHaveLength(2);
    await run(
      db(),
      "UPDATE developer_sponsors SET ended_at = ?, end_reason = 'removed' WHERE id = ?",
      [now, s],
    );
    expect((await wants(p.subject)).d.targets.get('developer')).toEqual([
      { kind: 'platform_grant' },
    ]);
    await run(
      db(),
      'UPDATE platform_role_grants SET revoked_at = ?, revoked_by = ? WHERE user_id = ?',
      [now, p.id, p.id],
    );
    expect((await wants(p.subject)).targets).toEqual([]);
  });

  it('wants support only from a platform grant', async () => {
    const p = await person(f);
    await insertGrant(db(), {
      id: f.ids.id(),
      userId: p.id,
      role: 'support',
      grantedBy: p.id,
      now,
    });
    expect((await wants(p.subject)).targets).toEqual(['support']);
  });
});

describe('desired state: overrides', () => {
  it('a disabled user wants nothing, whatever the sources', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    await membership(f, org.id, p);
    await group(f, 'g_disabled');
    await insert('idp_group_members', {
      id: f.ids.id(),
      group_key: 'g_disabled',
      subject: p.subject,
      source: 'manual',
      created_at: now,
    });
    expect((await wants(p.subject)).targets).toEqual(['console', 'g:g_disabled']);
    await run(db(), "UPDATE users SET status = 'disabled' WHERE id = ?", [p.id]);
    const { d } = await wants(p.subject);
    expect(d.skip).toBe('disabled');
    expect(d.targets.size).toBe(0);
    await run(db(), "UPDATE users SET status = 'active' WHERE id = ?", [p.id]);
    expect((await wants(p.subject)).d.skip).toBeNull();
  });

  it('a platform admin is skipped: no console, developer, support or group', async () => {
    const org = await standardOrg(f);
    const p = await person(f, { lastRoles: ['admin', 'developer', 'console'] });
    await membership(f, org.id, p);
    await insertGrant(db(), {
      id: f.ids.id(),
      userId: p.id,
      role: 'support',
      grantedBy: p.id,
      now,
    });
    await group(f, 'g_admins');
    await rule(f, 'g_admins', org.id, p.id);
    const { d } = await wants(p.subject);
    expect(d.skip).toBe('platform_admin');
    expect(d.targets.size).toBe(0);
  });

  it('a subject with no PassBook user keeps its group memberships and claims only', async () => {
    const orgUser = await person(f);
    const subject = 'sub-stranger';
    await group(f, 'g_guest');
    await insert('idp_group_members', {
      id: f.ids.id(),
      group_key: 'g_guest',
      subject,
      source: 'manual',
      created_at: now,
    });
    const { d } = await wants(subject);
    expect(d.userId).toBeNull();
    expect(targetKeys(d)).toEqual(['g:g_guest']);
    expect(orgUser.subject).not.toBe(subject);
  });
});

describe('desired state: org rules and group members', () => {
  it('an org rule wants its group for members with a listed role, and ends with the rule', async () => {
    const org = await standardOrg(f);
    const admin = await person(f);
    const reader = await person(f);
    await membership(f, org.id, admin, ['org_admin']);
    await membership(f, org.id, reader, ['read_only']);
    await group(f, 'g_staff');
    await group(f, 'g_all');
    const only = await rule(f, 'g_staff', org.id, admin.id, ['org_admin', 'template_author']);
    await rule(f, 'g_all', org.id, admin.id);
    expect((await wants(admin.subject)).targets).toEqual(['console', 'g:g_all', 'g:g_staff']);
    expect((await wants(reader.subject)).targets).toEqual(['console', 'g:g_all']);
    expect((await wants(admin.subject)).d.targets.get('g:g_staff')).toEqual([
      { kind: 'org_rule', ruleId: only, orgId: org.id },
    ]);
    await run(db(), 'UPDATE idp_group_rules SET ended_at = ?, ended_by = ? WHERE id = ?', [
      now,
      admin.id,
      only,
    ]);
    expect((await wants(admin.subject)).targets).toEqual(['console', 'g:g_all']);
  });

  it('a rule only counts while the org does, and a group deleted stops its rules and members', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    await membership(f, org.id, p);
    await group(f, 'g_gone');
    await rule(f, 'g_gone', org.id, p.id);
    expect((await wants(p.subject)).targets).toContain('g:g_gone');
    await run(db(), 'UPDATE orgs SET status = ? WHERE id = ?', ['deleted', org.id]);
    expect((await wants(p.subject)).targets).toEqual([]);
    await run(db(), 'UPDATE orgs SET status = ? WHERE id = ?', ['active', org.id]);
    await run(db(), 'UPDATE idp_groups SET deleted_at = ? WHERE key = ?', [now, 'g_gone']);
    expect((await wants(p.subject)).targets).toEqual(['console']);
  });

  it('sandboxes and personal orgs cannot feed a group', async () => {
    const sandbox = await sandboxOrg(f);
    const p = await person(f);
    const personal = await personalOrg(f, p);
    await group(f, 'g_never');
    for (const orgId of [sandbox.id, personal])
      expect(
        await insert('idp_group_rules', {
          id: f.ids.id(),
          group_key: 'g_never',
          org_id: orgId,
          created_by: p.id,
          created_at: now,
        }),
      ).toMatch(/invalid group rule/);
  });

  it('a removed manual member is no longer wanted', async () => {
    const p = await person(f);
    await group(f, 'g_manual');
    const id = f.ids.id();
    await insert('idp_group_members', {
      id,
      group_key: 'g_manual',
      subject: p.subject,
      source: 'manual',
      created_at: now,
    });
    expect((await wants(p.subject)).d.targets.get('g:g_manual')).toEqual([
      { kind: 'group_member', memberId: id, source: 'manual' },
    ]);
    await run(db(), 'UPDATE idp_group_members SET removed_at = ? WHERE id = ?', [now, id]);
    expect((await wants(p.subject)).targets).toEqual([]);
  });
});

describe('desired state: open setups and claims', () => {
  it('an open setup adds no reason: its subject is unknown until the proof', async () => {
    const org = await standardOrg(f);
    const admin = await person(f);
    const inv = await orgInvitation(f, org.id, 'new@example.test');
    await run(
      db(),
      'INSERT INTO org_invitation_setups (idp_token_id, invitation_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [f.ids.id(), inv, now, now + 1000],
    );
    expect((await wants(admin.subject)).targets).toEqual([]);
  });

  it('a member claim wants console, and the rules of the invited roles, inside its window', async () => {
    const org = await standardOrg(f);
    const admin = await person(f);
    const invitee = await person(f);
    await group(f, 'g_invited');
    await group(f, 'g_other');
    await rule(f, 'g_invited', org.id, admin.id, ['read_only']);
    await rule(f, 'g_other', org.id, admin.id, ['org_admin']);
    const inv = await orgInvitation(f, org.id, invitee.email, ['read_only']);
    const id = await claim(f, { org: inv }, invitee.subject, now + 3000);
    const { d, targets } = await wants(invitee.subject);
    expect(targets).toEqual(['console', 'g:g_invited']);
    expect(d.targets.get('console')).toEqual([
      { kind: 'claim', claimId: id, invitation: 'member' },
    ]);
    expect((await wants(invitee.subject, now + 2999)).targets).toEqual(['console', 'g:g_invited']);
    expect((await wants(invitee.subject, now + 3000)).targets).toEqual([]);
  });

  it('a claim ends when its invitation is revoked, accepted or swept', async () => {
    const org = await standardOrg(f);
    const a = await person(f);
    const b = await person(f);
    const c = await person(f);
    const revoked = await orgInvitation(f, org.id, 'r@example.test');
    const accepted = await orgInvitation(f, org.id, 'a@example.test');
    const swept = await orgInvitation(f, org.id, 's@example.test');
    const claimOf = (inv: string, p: { subject: string }) => claim(f, { org: inv }, p.subject);
    await claimOf(revoked, a);
    await claimOf(accepted, b);
    const sweptClaim = await claimOf(swept, c);
    for (const p of [a, b, c]) expect((await wants(p.subject)).targets).toEqual(['console']);
    await run(db(), 'UPDATE org_invitations SET revoked_at = ? WHERE id = ?', [now, revoked]);
    await run(db(), 'UPDATE org_invitations SET accepted_at = ? WHERE id = ?', [now, accepted]);
    await run(db(), 'UPDATE idp_invite_claims SET swept_at = ? WHERE id = ?', [now, sweptClaim]);
    for (const p of [a, b, c]) expect((await wants(p.subject)).targets).toEqual([]);
  });

  it('a developer claim wants developer, and console only while its paired member invitation is open', async () => {
    const org = await standardOrg(f);
    const admin = await person(f);
    const alone = await person(f);
    const paired = await person(f);
    const solo = await developerInvitation(f, org.id, admin.id, { email: alone.email });
    await claim(f, { developer: solo }, alone.subject);
    expect((await wants(alone.subject)).targets).toEqual(['developer']);

    const orgInv = await orgInvitation(f, org.id, paired.email, ['read_only']);
    const pair = await developerInvitation(f, org.id, admin.id, {
      email: paired.email,
      paired: orgInv,
    });
    await claim(f, { developer: pair }, paired.subject);
    expect((await wants(paired.subject)).targets).toEqual(['console', 'developer']);
    await run(db(), 'UPDATE org_invitations SET revoked_at = ? WHERE id = ?', [now, orgInv]);
    expect((await wants(paired.subject)).targets).toEqual(['developer']);
  });

  it('a platform claim wants its groups, and developer when chosen; a deleted group is dropped', async () => {
    const admin = await person(f);
    const guest = await person(f);
    await group(f, 'g_one');
    await group(f, 'g_two');
    const inv = await platformInvitation(f, admin.id, {
      groups: ['g_one', 'g_two'],
      developer: true,
    });
    await claim(f, { platform: inv }, guest.subject);
    expect((await wants(guest.subject)).targets).toEqual(['developer', 'g:g_one', 'g:g_two']);
    await run(db(), 'UPDATE idp_groups SET deleted_at = ? WHERE key = ?', [now, 'g_two']);
    expect((await wants(guest.subject)).targets).toEqual(['developer', 'g:g_one']);
  });

  it('a platform claim for a person with no PassBook user still resolves', async () => {
    const admin = await person(f);
    await group(f, 'g_solo');
    const inv = await platformInvitation(f, admin.id, { groups: ['g_solo'] });
    await claim(f, { platform: inv }, 'sub-no-user');
    const { d } = await wants('sub-no-user');
    expect(d.userId).toBeNull();
    expect(targetKeys(d)).toEqual(['g:g_solo']);
  });
});
