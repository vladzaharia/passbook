import { describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { setupGrant } from '../../platform/authority-test-fixtures.ts';
import { first } from '../../platform/db.ts';
import {
  insertDeveloperInvitation,
  insertSetup,
  invitationByHash,
  orgInvitations,
  pendingCount,
  pendingForEmail,
  revokeDeveloperInvitation,
  setupsOf,
  unclaimedPast,
} from './repo.ts';
import {
  endSponsor,
  insertSponsor,
  liveSponsorCount,
  liveSponsorOf,
  liveSponsorsOfUser,
  unsettled,
} from './repo-sponsors.ts';

async function setup(label: string) {
  const g = await setupGrant(label);
  const { s, route, member } = g;
  const principal = member();
  const audit = (action: string) => ({
    orgId: s.org.id,
    actorType: 'user' as const,
    actorId: s.user.id,
    action,
  });
  const now = s.f.clock.now();
  const invite = async (email = 'dev@example.test') => {
    const id = s.f.ids.id();
    const hash = s.f.ids.token();
    const orgId = s.f.ids.id();
    await insertDeveloperInvitation(
      route,
      principal,
      [],
      {
        id,
        email,
        hash,
        createdByUser: s.user.id,
        createdByKey: null,
        now,
        expires: now + 7 * 86_400_000,
        org: { id: orgId, roles: '["read_only"]', hash: s.f.ids.token() },
      },
      audit('developer_invitation.create'),
    );
    return { id, hash, orgId };
  };
  return { s, route, principal, audit, now, invite };
}

describe('dev-access repo', () => {
  it('writes the invitation and its org invitation together, then reads them back', async () => {
    const { s, now, invite } = await setup('da-invite');
    const { id, hash, orgId } = await invite();
    const row = await invitationByHash(s.f.env.DB, hash);
    expect(row).toMatchObject({
      id,
      org_id: s.org.id,
      org_invitation_id: orgId,
      created_by_user: s.user.id,
      created_by_key: null,
      claim_until: now + 7 * 86_400_000,
    });
    const paired = await first<{ roles: string; org_id: string }>(
      s.f.env.DB,
      'SELECT roles, org_id FROM org_invitations WHERE id = ?',
      [orgId],
    );
    expect(paired).toEqual({ roles: '["read_only"]', org_id: s.org.id });
    expect((await orgInvitations(s.f.env.DB, s.org.id)).map((r) => r.id)).toEqual([id]);
    expect((await pendingForEmail(s.f.env.DB, s.org.id, 'dev@example.test', now))?.id).toBe(id);
    expect(
      await pendingForEmail(s.f.env.DB, s.org.id, 'dev@example.test', now + 8 * 86_400_000),
    ).toBeNull();
    expect(await pendingCount(s.f.env.DB, s.org.id, now)).toBe(1);
    const audits = await first<{ n: number }>(
      s.f.env.DB,
      "SELECT count(*) AS n FROM audit_log WHERE action = 'developer_invitation.create' AND target_id = ?",
      [id],
    );
    expect(audits?.n).toBe(1);
  });

  it('revokes both rows once', async () => {
    const { s, route, principal, audit, now, invite } = await setup('da-revoke');
    const { id, orgId } = await invite();
    const inv = { id, orgInvitationId: orgId };
    expect(
      await revokeDeveloperInvitation(
        route,
        principal,
        [],
        inv,
        audit('developer_invitation.revoke'),
      ),
    ).toBe(true);
    expect(
      await revokeDeveloperInvitation(
        route,
        principal,
        [],
        inv,
        audit('developer_invitation.revoke'),
      ),
    ).toBe(false);
    const rows = await first<{ a: number | null; b: number | null }>(
      s.f.env.DB,
      `SELECT (SELECT revoked_at FROM developer_invitations WHERE id = ?) AS a,
              (SELECT revoked_at FROM org_invitations WHERE id = ?) AS b`,
      [id, orgId],
    );
    expect(rows?.a).not.toBeNull();
    expect(rows?.b).not.toBeNull();
    expect(await pendingCount(s.f.env.DB, s.org.id, now)).toBe(0);
  });

  it('records setups, three at most, and moves the claim window', async () => {
    const { s, route, principal, audit, now, invite } = await setup('da-setup');
    const { id, hash } = await invite();
    const record = (n: number) =>
      insertSetup(
        route,
        principal,
        [],
        {
          idpTokenId: `tok-${id}-${n}`,
          invitationId: id,
          now,
          expires: now + 3_600_000,
          claimUntil: now + 8 * 86_400_000 + n,
        },
        audit('developer_invitation.setup'),
      );
    for (const n of [1, 2, 3]) await record(n);
    await expect(record(4)).rejects.toThrow();
    expect(await setupsOf(s.f.env.DB, id)).toHaveLength(3);
    expect((await invitationByHash(s.f.env.DB, hash))?.claim_until).toBe(now + 8 * 86_400_000 + 3);
    const unclaimed = await unclaimedPast(s.f.env.DB, now + 9 * 86_400_000, 10);
    expect(unclaimed.map((r) => r.id)).toContain(id);
  });

  it('sponsors one person once per org and ends it once', async () => {
    const { s, route, principal, audit, now, invite } = await setup('da-sponsor');
    const person = await makeUser(s.f);
    const { id: invitationId } = await invite();
    const sponsorId = s.f.ids.id();
    await insertSponsor(
      route,
      principal,
      [],
      { id: sponsorId, userId: person.id, invitationId, subject: 'sub-1', source: 'signup', now },
      audit('developer_invitation.accept'),
    );
    expect((await liveSponsorOf(s.f.env.DB, s.org.id, person.id))?.id).toBe(sponsorId);
    expect(await liveSponsorCount(s.f.env.DB, s.org.id)).toBe(1);
    expect(await liveSponsorsOfUser(s.f.env.DB, person.id)).toHaveLength(1);
    const second = await invite('other@example.test');
    await expect(
      insertSponsor(
        route,
        principal,
        [],
        {
          id: s.f.ids.id(),
          userId: person.id,
          invitationId: second.id,
          subject: 'sub-1',
          source: 'added',
          now,
        },
        audit('developer_invitation.accept'),
      ),
    ).rejects.toThrow();
    expect(
      await endSponsor(route, principal, [], sponsorId, 'removed', audit('developer.remove')),
    ).toBe(true);
    expect(
      await endSponsor(route, principal, [], sponsorId, 'removed', audit('developer.remove')),
    ).toBe(false);
    expect(await liveSponsorCount(s.f.env.DB, s.org.id)).toBe(0);
    expect((await unsettled(s.f.env.DB, 10)).map((r) => r.id)).toContain(sponsorId);
  });
});
