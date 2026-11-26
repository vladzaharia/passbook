import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import {
  claim,
  db,
  developerInvitation,
  group,
  membership,
  orgInvitation,
  person,
  platformInvitation,
  standardOrg,
  world,
} from './access-test-fixtures.ts';
import { desiredState, targetKeys } from './desired.ts';
import {
  driftOfRun,
  openDrift,
  openDriftCounts,
  openDriftOf,
  openDriftOfSubject,
  recordDrift,
  resolveDrift,
} from './repo-drift.ts';
import {
  insertMember,
  liveMembershipsOfSubject,
  liveMembersOfGroup,
  memberById,
  removeMember,
  removeMembersOfGroup,
} from './repo-group-members.ts';
import {
  endRule,
  endRulesOfGroup,
  insertRule,
  liveRulesOfGroup,
  liveRulesOfOrg,
  ruleById,
} from './repo-group-rules.ts';
import {
  groupByKey,
  insertGroup,
  liveGroupCount,
  liveGroups,
  markGroupDeleted,
  renameGroup,
} from './repo-groups.ts';
import {
  claimsOfInvitation,
  insertClaim,
  markClaimSwept,
  unsettledClaims,
} from './repo-invite-claims.ts';
import {
  activePlatformGrants,
  grantHistory,
  insertGrant,
  insertGrantStmt,
  liveGrantOf,
  revokeAllGrants,
  revokeGrant,
} from './repo-role-grants.ts';
import { subjectsOfUser } from './repo-sources.ts';

const f = await world();
const now = f.clock.now();

describe('platform role grants', () => {
  it('grants once, revokes once, keeps history, and ends every live grant together', async () => {
    const p = await person(f);
    await insertGrant(db(), {
      id: f.ids.id(),
      userId: p.id,
      role: 'developer',
      grantedBy: p.id,
      now,
    });
    await expect(
      insertGrant(db(), { id: f.ids.id(), userId: p.id, role: 'developer', grantedBy: p.id, now }),
    ).rejects.toThrow();
    await insertGrantStmt(db(), {
      id: f.ids.id(),
      userId: p.id,
      role: 'support',
      grantedBy: p.id,
      now: now - 1,
    }).run();
    expect((await activePlatformGrants(db(), p.id)).map((g) => g.role)).toEqual([
      'developer',
      'support',
    ]);
    expect(await revokeGrant(db(), { userId: p.id, role: 'support', by: p.id, now: now + 1 })).toBe(
      true,
    );
    expect(await revokeGrant(db(), { userId: p.id, role: 'support', by: p.id, now: now + 2 })).toBe(
      false,
    );
    expect(await liveGrantOf(db(), p.id, 'support')).toBeNull();
    expect(await revokeAllGrants(db(), p.id, p.id, now + 3)).toEqual(['developer']);
    expect(await revokeAllGrants(db(), p.id, p.id, now + 4)).toEqual([]);
    await insertGrant(db(), {
      id: f.ids.id(),
      userId: p.id,
      role: 'developer',
      grantedBy: p.id,
      now: now + 5,
    });
    expect((await grantHistory(db(), p.id)).map((g) => [g.role, g.revoked_at])).toEqual([
      ['developer', null],
      ['developer', now + 3],
      ['support', now + 1],
    ]);
  });

  it('is per user: another user’s grant is never read or revoked', async () => {
    const a = await person(f);
    const b = await person(f);
    await insertGrant(db(), {
      id: f.ids.id(),
      userId: a.id,
      role: 'developer',
      grantedBy: a.id,
      now,
    });
    expect(await activePlatformGrants(db(), b.id)).toEqual([]);
    expect(await revokeGrant(db(), { userId: b.id, role: 'developer', by: b.id, now })).toBe(false);
    expect(await revokeAllGrants(db(), b.id, b.id, now)).toEqual([]);
    expect(await liveGrantOf(db(), a.id, 'developer')).not.toBeNull();
  });
});

describe('identity', () => {
  it('lists the Polaris ID subjects of a user and none for an unlinked one', async () => {
    const linked = await person(f);
    const unlinked = await person(f, { link: false });
    expect(await subjectsOfUser(db(), linked.id)).toEqual([linked.subject]);
    expect(await subjectsOfUser(db(), unlinked.id)).toEqual([]);
  });
});

describe('drift', () => {
  it('records an open difference once, closes it with a resolution, and reopens as a new row', async () => {
    const subject = `sub-drift-${f.ids.id()}`;
    const base = {
      runId: 'run-1',
      userId: null,
      subject,
      target: 'console' as const,
      kind: 'missing' as const,
      now,
    };
    expect(await recordDrift(db(), { ...base, id: f.ids.id() })).toBe(true);
    expect(await recordDrift(db(), { ...base, id: f.ids.id() })).toBe(false);
    expect(
      await recordDrift(db(), { ...base, id: f.ids.id(), kind: 'owner_removed', now: now + 1 }),
    ).toBe(true);
    expect((await openDriftOfSubject(db(), subject)).map((d) => d.kind)).toEqual([
      'missing',
      'owner_removed',
    ]);
    expect((await driftOfRun(db(), 'run-1')).filter((d) => d.subject === subject)).toHaveLength(2);
    expect((await openDriftOf(db(), subject, 'console', 'missing'))?.found_at).toBe(now);
    expect(await resolveDrift(db(), subject, 'console', 'missing', 'applied', now + 1)).toBe(true);
    expect(await resolveDrift(db(), subject, 'console', 'missing', 'applied', now + 2)).toBe(false);
    expect(await recordDrift(db(), { ...base, id: f.ids.id(), now: now + 3 })).toBe(true);
    expect((await openDriftOfSubject(db(), subject)).map((d) => d.kind)).toEqual([
      'owner_removed',
      'missing',
    ]);
    expect((await openDrift(db(), 1000)).some((d) => d.subject === subject)).toBe(true);
    expect(
      (await openDriftCounts(db())).find((c) => c.kind === 'owner_removed')?.n,
    ).toBeGreaterThan(0);
  });
});

describe('invite claims', () => {
  it('writes one claim per invitation and subject, lists them, and settles an expired one once', async () => {
    const org = await standardOrg(f);
    const inv = await orgInvitation(f, org.id, 'c@example.test');
    const claimUntil = now + 100;
    const row = (subject: string, id = f.ids.id()) => ({
      id,
      parent: { org: inv },
      subject,
      now,
      claimUntil,
    });
    expect(await insertClaim(db(), row('sub-c1'))).toBe(true);
    expect(await insertClaim(db(), row('sub-c1'))).toBe(false);
    expect((await claimsOfInvitation(db(), { org: inv })).map((c) => c.subject)).toEqual([
      'sub-c1',
    ]);
    const mine = (await unsettledClaims(db(), now + 100, 1000)).filter(
      (c) => c.org_invitation_id === inv,
    );
    expect(mine.map((c) => c.subject)).toEqual(['sub-c1']);
    expect(
      (await unsettledClaims(db(), now + 99, 1000)).some((c) => c.org_invitation_id === inv),
    ).toBe(false);
    expect(await markClaimSwept(db(), mine[0]?.id ?? '', now + 101)).toBe(true);
    expect(await markClaimSwept(db(), mine[0]?.id ?? '', now + 102)).toBe(false);
    expect(
      (await unsettledClaims(db(), now + 200, 1000)).some((c) => c.org_invitation_id === inv),
    ).toBe(false);
  });

  it('settles a claim whose invitation was revoked inside the window, and one whose invitation was accepted', async () => {
    const org = await standardOrg(f);
    const admin = await person(f);
    const revoked = await developerInvitation(f, org.id, admin.id);
    const accepted = await orgInvitation(f, org.id, 'a@example.test');
    await claim(f, { developer: revoked }, 'sub-r', now + 1000);
    await claim(f, { org: accepted }, 'sub-a', now + 1000);
    await run(db(), 'UPDATE developer_invitations SET revoked_at = ? WHERE id = ?', [now, revoked]);
    await run(db(), 'UPDATE org_invitations SET accepted_at = ? WHERE id = ?', [now, accepted]);
    const open = await unsettledClaims(db(), now + 1, 1000);
    expect(open.some((c) => c.developer_invitation_id === revoked)).toBe(true);
    // Accepted: the acceptor's reason is the membership now, and any other subject's claim is no reason; the sweep
    // marks each dirty and the drain keeps the one and takes back the other.
    expect(open.some((c) => c.org_invitation_id === accepted)).toBe(true);
  });

  it('claims of a platform invitation are found by that invitation', async () => {
    const admin = await person(f);
    await group(f, 'g_repo_claims');
    const inv = await platformInvitation(f, admin.id, { groups: ['g_repo_claims'] });
    await insertClaim(db(), {
      id: f.ids.id(),
      parent: { platform: inv },
      subject: 'sub-pc',
      now,
      claimUntil: now + 50,
    });
    expect((await claimsOfInvitation(db(), { platform: inv })).map((c) => c.subject)).toEqual([
      'sub-pc',
    ]);
    expect(await claimsOfInvitation(db(), { org: inv })).toEqual([]);
  });
});

describe('groups, rules and members', () => {
  it('creates, renames and deletes a group; a key is never reused; the limit count follows live groups', async () => {
    const admin = await person(f);
    const before = await liveGroupCount(db());
    await insertGroup(db(), {
      key: 'repo_grp',
      kind: 'custom',
      friendlyName: 'Repo group',
      createdBy: admin.id,
      now,
    });
    await expect(
      insertGroup(db(), {
        key: 'repo_grp',
        kind: 'custom',
        friendlyName: 'Again',
        createdBy: admin.id,
        now,
      }),
    ).rejects.toThrow();
    expect(await liveGroupCount(db())).toBe(before + 1);
    expect(await renameGroup(db(), 'repo_grp', 'Renamed')).toBe(true);
    expect((await groupByKey(db(), 'repo_grp'))?.friendly_name).toBe('Renamed');
    expect((await liveGroups(db())).some((g) => g.key === 'repo_grp')).toBe(true);
    expect(await markGroupDeleted(db(), 'repo_grp', now + 1)).toBe(true);
    expect(await markGroupDeleted(db(), 'repo_grp', now + 2)).toBe(false);
    expect(await renameGroup(db(), 'repo_grp', 'After')).toBe(false);
    expect(await liveGroupCount(db())).toBe(before);
    await expect(
      insertGroup(db(), {
        key: 'repo_grp',
        kind: 'custom',
        friendlyName: 'Again',
        createdBy: admin.id,
        now,
      }),
    ).rejects.toThrow();
  });

  it('rules are listed by group and by org only, and end once', async () => {
    const a = await standardOrg(f);
    const b = await standardOrg(f);
    const admin = await person(f);
    await group(f, 'repo_rules');
    const r1 = {
      id: f.ids.id(),
      groupKey: 'repo_rules',
      orgId: a.id,
      orgRoles: ['org_admin'],
      createdBy: admin.id,
      now,
    };
    await insertRule(db(), r1);
    await insertRule(db(), { ...r1, id: f.ids.id(), orgId: b.id, orgRoles: null });
    expect((await liveRulesOfOrg(db(), a.id)).map((r) => [r.group_key, r.org_roles])).toEqual([
      ['repo_rules', '["org_admin"]'],
    ]);
    expect((await liveRulesOfGroup(db(), 'repo_rules')).map((r) => r.org_id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect((await ruleById(db(), r1.id))?.org_id).toBe(a.id);
    expect(await ruleById(db(), 'nope')).toBeNull();
    expect(await endRule(db(), r1.id, admin.id, now + 1)).toBe(true);
    expect(await endRule(db(), r1.id, admin.id, now + 2)).toBe(false);
    expect(await liveRulesOfOrg(db(), a.id)).toEqual([]);
    expect((await liveRulesOfOrg(db(), b.id)).length).toBe(1);
    expect(await endRulesOfGroup(db(), 'repo_rules', admin.id, now + 3)).toHaveLength(1);
    expect(await liveRulesOfGroup(db(), 'repo_rules')).toEqual([]);
  });

  it('a rule of one org gives its group to that org’s members and nobody else', async () => {
    const a = await standardOrg(f);
    const b = await standardOrg(f);
    const admin = await person(f);
    const inA = await person(f);
    const inB = await person(f);
    await membership(f, a.id, inA);
    await membership(f, b.id, inB);
    await group(f, 'repo_scope');
    await insertRule(db(), {
      id: f.ids.id(),
      groupKey: 'repo_scope',
      orgId: a.id,
      orgRoles: null,
      createdBy: admin.id,
      now,
    });
    expect(targetKeys(await desiredState(db(), inA.subject, now))).toEqual([
      'console',
      'g:repo_scope',
    ]);
    expect(targetKeys(await desiredState(db(), inB.subject, now))).toEqual(['console']);
  });

  it('members are listed by group and subject, removed once, and a group delete removes them all', async () => {
    await group(f, 'repo_members');
    const mk = (subject: string) => ({
      id: f.ids.id(),
      groupKey: 'repo_members',
      subject,
      userId: null,
      platformInvitationId: null,
      addedBy: null,
      now,
    });
    const m1 = mk('sub-m1');
    await insertMember(db(), m1);
    await insertMember(db(), mk('sub-m2'));
    await expect(insertMember(db(), mk('sub-m1'))).rejects.toThrow();
    expect((await liveMembersOfGroup(db(), 'repo_members')).map((m) => m.subject).sort()).toEqual([
      'sub-m1',
      'sub-m2',
    ]);
    expect((await liveMembershipsOfSubject(db(), 'sub-m1')).map((m) => m.group_key)).toEqual([
      'repo_members',
    ]);
    expect((await memberById(db(), m1.id))?.subject).toBe('sub-m1');
    expect(await removeMember(db(), m1.id, null, now + 1)).toBe(true);
    expect(await removeMember(db(), m1.id, null, now + 2)).toBe(false);
    expect(await removeMembersOfGroup(db(), 'repo_members', null, now + 3)).toHaveLength(1);
    expect(await liveMembersOfGroup(db(), 'repo_members')).toEqual([]);
    await insertMember(db(), { ...mk('sub-m1'), id: f.ids.id() });
  });
});
