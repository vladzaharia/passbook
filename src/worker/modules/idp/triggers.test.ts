import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import {
  claim,
  clearMarks,
  db,
  developerInvitation,
  group,
  marked,
  membership,
  orgInvitation,
  person,
  platformInvitation,
  revokeMembership,
  rule,
  sponsor,
  standardOrg,
  world,
} from './access-test-fixtures.ts';
import { insertGrant } from './repo-role-grants.ts';

const f = await world();
const now = f.clock.now();

/** Runs `change` and returns which of `people` it marked, clearing their marks first and after. */
async function marks(people: { subject: string }[], change: () => Promise<unknown>) {
  const subjects = people.map((p) => p.subject);
  await clearMarks(subjects);
  await change();
  const out = await marked(subjects);
  await clearMarks(subjects);
  return out;
}

describe('dirty marks from org status, sponsorships and roles', () => {
  it('an org status change marks its sponsored developers and the claims on its invitations too', async () => {
    const org = await standardOrg(f);
    const sponsored = await person(f);
    await sponsor(f, org.id, sponsored);
    const invited = await person(f, { link: false });
    const inv = await orgInvitation(f, org.id, 'x@example.test');
    await claim(f, { org: inv }, invited.subject);
    const bystander = await person(f);
    expect(
      await marks([sponsored, invited, bystander], () =>
        run(db(), 'UPDATE orgs SET status = ? WHERE id = ?', ['suspended', org.id]),
      ),
    ).toEqual([sponsored.subject, invited.subject].sort());
  });

  it('a change of last_roles marks the user, a sign-in that repeats them does not', async () => {
    const p = await person(f);
    const set = (roles: string[]) =>
      run(db(), 'UPDATE users SET last_roles = ? WHERE id = ?', [JSON.stringify(roles), p.id]);
    expect(await marks([p], () => set(['user', 'admin']))).toEqual([p.subject]);
    expect(await marks([p], () => set(['user', 'admin']))).toEqual([]);
    expect(await marks([p], () => set(['user']))).toEqual([p.subject]);
  });
});

describe('dirty marks from user-keyed sources', () => {
  it('linking a Polaris ID identity marks its subject, another provider does not', async () => {
    const p = await person(f, { link: false });
    const subject = `sub-${p.id}`;
    await run(
      db(),
      "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('magic', ?, ?, ?)",
      [subject, p.id, now],
    );
    expect(await marked([subject])).toEqual([]);
    await run(
      db(),
      "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, ?)",
      [subject, p.id, now],
    );
    expect(await marked([subject])).toEqual([subject]);
  });

  it('a membership marks its user when accepted and when revoked, and only that user', async () => {
    const org = await standardOrg(f);
    const a = await person(f);
    const b = await person(f);
    const unlinked = await person(f, { link: false });
    let id = '';
    expect(
      await marks([a, b], async () => {
        id = await membership(f, org.id, a);
      }),
    ).toEqual([a.subject]);
    expect(await marks([a, b], () => revokeMembership(id, now))).toEqual([a.subject]);
    // A user with no Polaris ID identity has nothing to project.
    await membership(f, org.id, unlinked);
    expect(await marked([unlinked.subject])).toEqual([]);
  });

  it('a sponsorship marks its user when it starts and when it ends', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    let id = '';
    expect(
      await marks([p], async () => {
        id = await sponsor(f, org.id, p);
      }),
    ).toEqual([p.subject]);
    expect(
      await marks([p], () =>
        run(
          db(),
          "UPDATE developer_sponsors SET ended_at = ?, end_reason = 'removed' WHERE id = ?",
          [now, id],
        ),
      ),
    ).toEqual([p.subject]);
  });

  it('a platform grant marks its user when granted and when revoked', async () => {
    const p = await person(f);
    expect(
      await marks([p], () =>
        insertGrant(db(), {
          id: f.ids.id(),
          userId: p.id,
          role: 'developer',
          grantedBy: p.id,
          now,
        }),
      ),
    ).toEqual([p.subject]);
    expect(
      await marks([p], () =>
        run(
          db(),
          'UPDATE platform_role_grants SET revoked_at = ?, revoked_by = ? WHERE user_id = ?',
          [now, p.id, p.id],
        ),
      ),
    ).toEqual([p.subject]);
  });

  it('a status change marks the user, an unrelated update does not', async () => {
    const p = await person(f);
    expect(
      await marks([p], () =>
        run(db(), "UPDATE users SET status = 'disabled' WHERE id = ?", [p.id]),
      ),
    ).toEqual([p.subject]);
    expect(
      await marks([p], () => run(db(), "UPDATE users SET status = 'active' WHERE id = ?", [p.id])),
    ).toEqual([p.subject]);
    expect(
      await marks([p], () => run(db(), "UPDATE users SET name = 'N' WHERE id = ?", [p.id])),
    ).toEqual([]);
  });

  it('an org status change marks the live members of that org only', async () => {
    const org = await standardOrg(f);
    const other = await standardOrg(f);
    const live = await person(f);
    const revoked = await person(f);
    const elsewhere = await person(f);
    await membership(f, org.id, live);
    const gone = await membership(f, org.id, revoked);
    await revokeMembership(gone, now);
    await membership(f, other.id, elsewhere);
    const people = [live, revoked, elsewhere];
    expect(
      await marks(people, () =>
        run(db(), 'UPDATE orgs SET status = ? WHERE id = ?', ['suspended', org.id]),
      ),
    ).toEqual([live.subject]);
    expect(
      await marks(people, () =>
        run(db(), 'UPDATE orgs SET name = ? WHERE id = ?', ['Renamed', org.id]),
      ),
    ).toEqual([]);
  });
});

describe('dirty marks from group sources', () => {
  it('a rule marks every live member of its org when it starts and when it ends', async () => {
    const org = await standardOrg(f);
    const a = await person(f);
    const b = await person(f);
    const outsider = await person(f);
    await membership(f, org.id, a);
    await membership(f, org.id, b, ['read_only']);
    await group(f, 'g_trig_rule');
    let id = '';
    const people = [a, b, outsider];
    expect(
      await marks(people, async () => {
        id = await rule(f, 'g_trig_rule', org.id, a.id);
      }),
    ).toEqual([a.subject, b.subject].sort());
    expect(
      await marks(people, () =>
        run(db(), 'UPDATE idp_group_rules SET ended_at = ?, ended_by = ? WHERE id = ?', [
          now,
          a.id,
          id,
        ]),
      ),
    ).toEqual([a.subject, b.subject].sort());
  });

  it('a group member marks its subject, even with no PassBook user', async () => {
    await group(f, 'g_trig_member');
    const subject = 'sub-no-user-trigger';
    await clearMarks([subject]);
    const id = f.ids.id();
    await run(
      db(),
      "INSERT INTO idp_group_members (id, group_key, subject, source, created_at) VALUES (?, 'g_trig_member', ?, 'manual', ?)",
      [id, subject, now],
    );
    expect(await marked([subject])).toEqual([subject]);
    await clearMarks([subject]);
    await run(db(), 'UPDATE idp_group_members SET removed_at = ? WHERE id = ?', [now, id]);
    expect(await marked([subject])).toEqual([subject]);
  });
});

describe('dirty marks from claims and invitations', () => {
  it('a claim marks its subject, a paired claim again when either invitation ends', async () => {
    const org = await standardOrg(f);
    const admin = await person(f);
    const dev = await person(f);
    const orgInv = await orgInvitation(f, org.id, dev.email);
    const devInv = await developerInvitation(f, org.id, admin.id, {
      email: dev.email,
      paired: orgInv,
    });
    await clearMarks([dev.subject]);
    const id = await claim(f, { developer: devInv }, dev.subject);
    expect(await marked([dev.subject])).toEqual([dev.subject]);
    await clearMarks([dev.subject]);
    // The paired member invitation ends: the claim's console reason goes with it.
    await run(db(), 'UPDATE org_invitations SET revoked_at = ? WHERE id = ?', [now, orgInv]);
    expect(await marked([dev.subject])).toEqual([dev.subject]);
    await clearMarks([dev.subject]);
    await run(db(), 'UPDATE developer_invitations SET revoked_at = ? WHERE id = ?', [now, devInv]);
    expect(await marked([dev.subject])).toEqual([dev.subject]);
    await clearMarks([dev.subject]);
    await run(db(), 'UPDATE idp_invite_claims SET swept_at = ? WHERE id = ?', [now, id]);
    expect(await marked([dev.subject])).toEqual([dev.subject]);
  });

  it('a member claim marks when its invitation is accepted', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    const inv = await orgInvitation(f, org.id, p.email);
    await claim(f, { org: inv }, p.subject);
    await clearMarks([p.subject]);
    await run(db(), 'UPDATE org_invitations SET accepted_at = ? WHERE id = ?', [now, inv]);
    expect(await marked([p.subject])).toEqual([p.subject]);
  });

  it('a platform invitation marks its claimants and its accepted subject', async () => {
    const admin = await person(f);
    const claimant = await person(f);
    const acceptor = await person(f);
    await group(f, 'g_trig_plat');
    const inv = await platformInvitation(f, admin.id, { groups: ['g_trig_plat'] });
    await claim(f, { platform: inv }, claimant.subject);
    await clearMarks([claimant.subject, acceptor.subject]);
    expect(await marked([claimant.subject, acceptor.subject])).toEqual([]);
    await run(
      db(),
      'UPDATE platform_invitations SET accepted_at = ?, accepted_subject = ? WHERE id = ?',
      [now, acceptor.subject, inv],
    );
    expect(await marked([claimant.subject, acceptor.subject])).toEqual(
      [claimant.subject, acceptor.subject].sort(),
    );
  });
});

describe('the queue row', () => {
  it('a new mark bumps the version and resets the backoff', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    await clearMarks([p.subject]);
    await membership(f, org.id, p);
    await run(db(), 'UPDATE idp_dirty SET attempts = 3, next_at = 99999 WHERE subject = ?', [
      p.subject,
    ]);
    const before = await first<{ version: number }>(
      db(),
      'SELECT version FROM idp_dirty WHERE subject = ?',
      [p.subject],
    );
    await run(db(), "UPDATE users SET status = 'disabled' WHERE id = ?", [p.id]);
    const after = await first<{ version: number; attempts: number; next_at: number }>(
      db(),
      'SELECT version, attempts, next_at FROM idp_dirty WHERE subject = ?',
      [p.subject],
    );
    expect(after).toEqual({ version: (before?.version ?? 0) + 1, attempts: 0, next_at: 0 });
  });
});
