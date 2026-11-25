import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import {
  claim,
  db,
  developerInvitation,
  group,
  insert,
  orgInvitation,
  person,
  platformInvitation,
  refused,
  rule,
  standardOrg,
  startPurge,
  update,
  world,
} from './access-test-fixtures.ts';

const f = await world();
const now = f.clock.now();
const row = (extra: Record<string, string | number | null>) => ({ id: f.ids.id(), ...extra });

describe('platform_role_grants', () => {
  const grant = (userId: string, over: Record<string, string | number | null> = {}) =>
    insert(
      'platform_role_grants',
      row({ user_id: userId, role: 'developer', granted_by: userId, created_at: now, ...over }),
    );

  it('takes developer or support, one live row per user and role, and revoked_by with revoked_at', async () => {
    const p = await person(f);
    expect(await grant(p.id, { role: 'admin' })).toMatch(/CHECK/);
    expect(await grant(p.id)).toBeNull();
    expect(await grant(p.id)).toMatch(/UNIQUE/);
    expect(await grant(p.id, { role: 'support' })).toBeNull();
    expect(await grant(p.id, { revoked_at: now })).toMatch(/CHECK/);
  });

  it('is history: identity never changes, a revoke is set once, nothing is deleted or replaced', async () => {
    const p = await person(f);
    const id = f.ids.id();
    await insert('platform_role_grants', {
      id,
      user_id: p.id,
      role: 'support',
      granted_by: p.id,
      created_at: now,
    });
    expect(await update('platform_role_grants', "role = 'developer'", 'id = ?', [id])).toMatch(
      /immutable/,
    );
    expect(await update('platform_role_grants', 'created_at = 1', 'id = ?', [id])).toMatch(
      /immutable/,
    );
    expect(
      await update('platform_role_grants', 'revoked_at = ?, revoked_by = ?', 'id = ?', [
        now,
        p.id,
        id,
      ]),
    ).toBeNull();
    expect(await update('platform_role_grants', 'revoked_at = ?', 'id = ?', [now + 1, id])).toMatch(
      /immutable/,
    );
    expect(await refused('DELETE FROM platform_role_grants WHERE id = ?', [id])).toMatch(
      /immutable/,
    );
    const again = await refused(
      'INSERT OR REPLACE INTO platform_role_grants (id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, p.id, 'support', p.id, now],
    );
    expect(again).toMatch(/UNIQUE/);
    expect(await grant(p.id, { role: 'support' })).toBeNull();
  });
});

describe('idp_groups', () => {
  const make = (key: string) =>
    insert('idp_groups', { key, kind: 'custom', friendly_name: 'Staff', created_at: now });

  it('takes a lowercase key of 2 to 40 characters that is not a role name', async () => {
    for (const key of [
      'a',
      'A_b',
      'ab-c',
      '1ab',
      'console',
      'platform_admin',
      'users',
      'x'.repeat(41),
    ])
      expect(await make(key), key).toMatch(/CHECK/);
    expect(await make('staff_ok')).toBeNull();
    expect(await make('staff_ok')).toMatch(/UNIQUE|key/);
  });

  it('never changes its key or kind; only the display name moves; a delete is set once and final', async () => {
    await make('staff_immut');
    expect(await update('idp_groups', "key = 'other'", 'key = ?', ['staff_immut'])).toMatch(
      /immutable|FOREIGN/,
    );
    expect(await update('idp_groups', "kind = 'adopted'", 'key = ?', ['staff_immut'])).toMatch(
      /immutable/,
    );
    expect(
      await update('idp_groups', "friendly_name = 'Renamed'", 'key = ?', ['staff_immut']),
    ).toBeNull();
    expect(await update('idp_groups', "friendly_name = 'X'", 'key = ?', ['staff_immut'])).toMatch(
      /CHECK/,
    );
    expect(
      await update('idp_groups', 'deleted_at = ?', 'key = ?', [now, 'staff_immut']),
    ).toBeNull();
    expect(
      await update('idp_groups', 'deleted_at = ?', 'key = ?', [now + 1, 'staff_immut']),
    ).toMatch(/immutable/);
    expect(
      await update('idp_groups', "friendly_name = 'After'", 'key = ?', ['staff_immut']),
    ).toMatch(/immutable/);
    expect(await refused('DELETE FROM idp_groups WHERE key = ?', ['staff_immut'])).toMatch(
      /immutable/,
    );
    expect(await make('staff_immut')).toMatch(/UNIQUE|key/);
  });
});

describe('idp_group_rules', () => {
  const make = (key: string, orgId: string, by: string, roles: string | null = null) =>
    insert(
      'idp_group_rules',
      row({ group_key: key, org_id: orgId, org_roles: roles, created_by: by, created_at: now }),
    );

  it('refuses a missing or deleted group, bad roles, and a second live rule for the pair', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    expect(await make('g_nope', org.id, p.id)).toMatch(/invalid group rule/);
    await group(f, 'g_rules');
    expect(await make('g_rules', org.id, p.id, '[]')).toMatch(/CHECK/);
    expect(await make('g_rules', org.id, p.id, '["owner"]')).toMatch(/invalid group rule/);
    expect(await make('g_rules', org.id, p.id, '["org_admin","org_admin"]')).toMatch(
      /invalid group rule/,
    );
    expect(await make('g_rules', org.id, p.id, '{"a":1}')).toMatch(/CHECK|invalid group rule/);
    expect(await make('g_rules', org.id, p.id, '["org_admin"]')).toBeNull();
    expect(await make('g_rules', org.id, p.id)).toMatch(/UNIQUE/);
    await group(f, 'g_rules_gone');
    await update('idp_groups', 'deleted_at = ?', 'key = ?', [now, 'g_rules_gone']);
    expect(await make('g_rules_gone', org.id, p.id)).toMatch(/invalid group rule/);
  });

  it('allows five live rules a group, and a sixth only after one ends', async () => {
    const p = await person(f);
    await group(f, 'g_five');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const org = await standardOrg(f);
      ids.push(await rule(f, 'g_five', org.id, p.id));
    }
    const sixth = await standardOrg(f);
    expect(await make('g_five', sixth.id, p.id)).toMatch(/invalid group rule/);
    await update('idp_group_rules', 'ended_at = ?, ended_by = ?', 'id = ?', [now, p.id, ids[0]]);
    expect(await make('g_five', sixth.id, p.id)).toBeNull();
  });

  it('is history: an end is set once, and a rule is deleted only by the org purge', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    await group(f, 'g_hist');
    const id = await rule(f, 'g_hist', org.id, p.id);
    expect(await update('idp_group_rules', 'ended_at = ?', 'id = ?', [now, id])).toMatch(/CHECK/);
    expect(await update('idp_group_rules', "group_key = 'g_five'", 'id = ?', [id])).toMatch(
      /immutable/,
    );
    expect(
      await update('idp_group_rules', 'ended_at = ?, ended_by = ?', 'id = ?', [now, p.id, id]),
    ).toBeNull();
    expect(await update('idp_group_rules', 'ended_at = ?', 'id = ?', [now + 1, id])).toMatch(
      /immutable/,
    );
    expect(await refused('DELETE FROM idp_group_rules WHERE id = ?', [id])).toMatch(/immutable/);
    await startPurge(org.id, now);
    expect(await refused('DELETE FROM idp_group_rules WHERE id = ?', [id])).toBeNull();
  });
});

describe('idp_group_members', () => {
  it('needs a live group, the invitation link exactly for the invitation source, one live row per pair', async () => {
    const p = await person(f);
    const make = (key: string, extra: Record<string, string | number | null> = {}) =>
      insert(
        'idp_group_members',
        row({ group_key: key, subject: p.subject, source: 'manual', created_at: now, ...extra }),
      );
    expect(await make('g_missing')).toMatch(/invalid group member/);
    await group(f, 'g_members');
    expect(await make('g_members', { source: 'invitation' })).toMatch(/CHECK/);
    expect(await make('g_members', { platform_invitation_id: 'x' })).toMatch(/CHECK/);
    expect(await make('g_members')).toBeNull();
    expect(await make('g_members')).toMatch(/UNIQUE/);
  });

  it('is history: removal is set once, nothing is deleted', async () => {
    const p = await person(f);
    await group(f, 'g_members_hist');
    const id = f.ids.id();
    await insert('idp_group_members', {
      id,
      group_key: 'g_members_hist',
      subject: p.subject,
      source: 'manual',
      created_at: now,
    });
    expect(await update('idp_group_members', "subject = 'other'", 'id = ?', [id])).toMatch(
      /immutable/,
    );
    expect(await update('idp_group_members', 'removed_at = ?', 'id = ?', [now, id])).toBeNull();
    expect(await update('idp_group_members', 'removed_at = ?', 'id = ?', [now + 1, id])).toMatch(
      /immutable/,
    );
    expect(await refused('DELETE FROM idp_group_members WHERE id = ?', [id])).toMatch(/immutable/);
    await insert('idp_group_members', {
      id: f.ids.id(),
      group_key: 'g_members_hist',
      subject: p.subject,
      source: 'manual',
      created_at: now + 5,
    });
  });
});

describe('platform_invitations', () => {
  it('takes only live groups, at most five, and developer or a group', async () => {
    const p = await person(f);
    await group(f, 'g_pi');
    const make = (groups: string, developer = 0) =>
      insert(
        'platform_invitations',
        row({
          email: 'a@example.test',
          token_hash: f.ids.token(),
          groups,
          developer,
          created_by_user: p.id,
          created_at: now,
          expires_at: now + 10,
          claim_until: now + 10,
        }),
      );
    expect(await make('["g_nope"]')).toMatch(/invalid platform invitation groups/);
    expect(await make('["g_pi","g_pi"]')).toMatch(/invalid platform invitation groups/);
    expect(await make('[1]')).toMatch(/invalid platform invitation groups/);
    expect(await make('[]')).toMatch(/CHECK/);
    expect(await make('["g_pi"]')).toBeNull();
    expect(await make('[]', 1)).toBeNull();
    expect(await make('["a","b","c","d","e","f"]')).toMatch(
      /CHECK|invalid platform invitation groups/,
    );
  });

  it('is history: one end state, set once, claim window never shortened, never deleted', async () => {
    const p = await person(f);
    await group(f, 'g_pi_hist');
    const id = await platformInvitation(f, p.id, { groups: ['g_pi_hist'] });
    expect(
      await update('platform_invitations', "email = 'b@example.test'", 'id = ?', [id]),
    ).toMatch(/immutable/);
    expect(
      await update('platform_invitations', 'claim_until = claim_until - 1', 'id = ?', [id]),
    ).toMatch(/immutable|CHECK/);
    expect(await update('platform_invitations', 'accepted_at = ?', 'id = ?', [now, id])).toMatch(
      /CHECK/,
    );
    expect(
      await update('platform_invitations', 'accepted_at = ?, accepted_subject = ?', 'id = ?', [
        now,
        p.subject,
        id,
      ]),
    ).toBeNull();
    expect(await update('platform_invitations', 'revoked_at = ?', 'id = ?', [now, id])).toMatch(
      /CHECK/,
    );
    expect(
      await update('platform_invitations', 'accepted_subject = ?', 'id = ?', ['other', id]),
    ).toMatch(/immutable/);
    expect(await refused('DELETE FROM platform_invitations WHERE id = ?', [id])).toMatch(
      /immutable/,
    );
  });
});

describe('setups', () => {
  const setup = (table: string, invitationId: string) =>
    insert(table, {
      idp_token_id: f.ids.id(),
      invitation_id: invitationId,
      created_at: now,
      expires_at: now + 10,
    });

  it('are capped at three per invitation and refused on an invitation that ended, for all three kinds', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    await group(f, 'g_setups');
    const kinds = [
      [
        'org_invitation_setups',
        () => orgInvitation(f, org.id, 'o@example.test'),
        'org_invitations',
      ],
      [
        'developer_invite_setups',
        () => developerInvitation(f, org.id, p.id),
        'developer_invitations',
      ],
      [
        'platform_invitation_setups',
        () => platformInvitation(f, p.id, { groups: ['g_setups'] }),
        'platform_invitations',
      ],
    ] as const;
    for (const [table, make, parent] of kinds) {
      const id = await make();
      for (let i = 0; i < 3; i++) expect(await setup(table, id), table).toBeNull();
      expect(await setup(table, id), table).toMatch(/refused|cap/);
      const ended = await make();
      await update(parent, 'revoked_at = ?', 'id = ?', [now, ended]);
      expect(await setup(table, ended), table).toMatch(/refused/);
      const accepted = await make();
      if (parent === 'platform_invitations')
        await update(parent, 'accepted_at = ?, accepted_subject = ?', 'id = ?', [
          now,
          p.subject,
          accepted,
        ]);
      else if (parent === 'org_invitations')
        await update(parent, 'accepted_at = ?', 'id = ?', [now, accepted]);
      else
        await update(parent, 'accepted_at = ?, accepted_user_id = ?', 'id = ?', [
          now,
          p.id,
          accepted,
        ]);
      expect(await setup(table, accepted), table).toMatch(/refused/);
    }
  });

  it('are immutable and are deleted only by the org purge (org setups)', async () => {
    const org = await standardOrg(f);
    const inv = await orgInvitation(f, org.id, 's@example.test');
    const token = f.ids.id();
    await insert('org_invitation_setups', {
      idp_token_id: token,
      invitation_id: inv,
      created_at: now,
      expires_at: now + 10,
    });
    expect(
      await update('org_invitation_setups', 'expires_at = 1', 'idp_token_id = ?', [token]),
    ).toMatch(/immutable/);
    expect(
      await refused('DELETE FROM org_invitation_setups WHERE idp_token_id = ?', [token]),
    ).toMatch(/immutable/);
    await startPurge(org.id, now);
    expect(
      await refused('DELETE FROM org_invitation_setups WHERE idp_token_id = ?', [token]),
    ).toBeNull();
  });
});

describe('idp_invite_claims', () => {
  it('names exactly one invitation, one claim per subject, at most three per invitation', async () => {
    const org = await standardOrg(f);
    const inv = await orgInvitation(f, org.id, 'c@example.test');
    const base = { id: f.ids.id(), subject: 's1', created_at: now, claim_until: now + 10 };
    expect(await insert('idp_invite_claims', base)).toMatch(/CHECK/);
    expect(
      await insert('idp_invite_claims', {
        ...base,
        org_invitation_id: inv,
        platform_invitation_id: inv,
      }),
    ).toMatch(/CHECK|FOREIGN/);
    expect(
      await insert('idp_invite_claims', { ...base, org_invitation_id: inv, claim_until: now }),
    ).toMatch(/CHECK/);
    await claim(f, { org: inv }, 's1');
    expect(
      await refused(
        'INSERT INTO idp_invite_claims (id, org_invitation_id, subject, created_at, claim_until) VALUES (?, ?, ?, ?, ?)',
        [f.ids.id(), inv, 's1', now, now + 10],
      ),
    ).toMatch(/UNIQUE/);
    await claim(f, { org: inv }, 's2');
    await claim(f, { org: inv }, 's3');
    expect(
      await refused(
        'INSERT INTO idp_invite_claims (id, org_invitation_id, subject, created_at, claim_until) VALUES (?, ?, ?, ?, ?)',
        [f.ids.id(), inv, 's4', now, now + 10],
      ),
    ).toMatch(/claim refused/);
  });

  it('is refused on an ended invitation and past the claim window of a developer or platform invitation', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    await group(f, 'g_claims');
    const dev = await developerInvitation(f, org.id, p.id, { claimUntil: now + 1100 });
    const plat = await platformInvitation(f, p.id, {
      groups: ['g_claims'],
      claimUntil: now + 1100,
    });
    const ins = (col: string, id: string, until: number) =>
      refused(
        `INSERT INTO idp_invite_claims (id, ${col}, subject, created_at, claim_until) VALUES (?, ?, ?, ?, ?)`,
        [f.ids.id(), id, f.ids.id(), now, until],
      );
    for (const [col, id] of [
      ['developer_invitation_id', dev],
      ['platform_invitation_id', plat],
    ] as const) {
      expect(await ins(col, id, now + 1101)).toMatch(/claim refused/);
      expect(await ins(col, id, now + 1100)).toBeNull();
    }
    const orgInv = await orgInvitation(f, org.id, 'x@example.test');
    await update('org_invitations', 'revoked_at = ?', 'id = ?', [now, orgInv]);
    expect(await ins('org_invitation_id', orgInv, now + 5)).toMatch(/claim refused/);
  });

  it('is immutable except the sweep mark, set once; deleted only by the org purge, never a platform one', async () => {
    const org = await standardOrg(f);
    const p = await person(f);
    await group(f, 'g_claims_hist');
    const inv = await orgInvitation(f, org.id, 'h@example.test');
    const id = await claim(f, { org: inv }, 'sub-h');
    expect(await update('idp_invite_claims', "subject = 'other'", 'id = ?', [id])).toMatch(
      /immutable/,
    );
    expect(
      await update('idp_invite_claims', 'claim_until = claim_until + 1', 'id = ?', [id]),
    ).toMatch(/immutable/);
    expect(await update('idp_invite_claims', 'swept_at = ?', 'id = ?', [now, id])).toBeNull();
    expect(await update('idp_invite_claims', 'swept_at = ?', 'id = ?', [now + 1, id])).toMatch(
      /immutable/,
    );
    expect(await refused('DELETE FROM idp_invite_claims WHERE id = ?', [id])).toMatch(/immutable/);
    await startPurge(org.id, now);
    expect(await refused('DELETE FROM idp_invite_claims WHERE id = ?', [id])).toBeNull();
    const plat = await platformInvitation(f, p.id, { groups: ['g_claims_hist'] });
    const pid = await claim(f, { platform: plat }, 'sub-p');
    expect(await refused('DELETE FROM idp_invite_claims WHERE id = ?', [pid])).toMatch(/immutable/);
  });
});

describe('idp_drift and idp_target_state', () => {
  it('takes a known kind and a valid target; resolved_at and resolution come together, set once', async () => {
    const drift = (over: Record<string, string | number | null> = {}) =>
      insert(
        'idp_drift',
        row({
          run_id: 'r1',
          subject: 's',
          target: 'console',
          kind: 'missing',
          found_at: now,
          ...over,
        }),
      );
    expect(await drift({ kind: 'bogus' })).toMatch(/CHECK/);
    for (const target of ['admin', 'g:', 'g:A', 'g:a', 'g:ab-c', `g:${'a'.repeat(41)}`])
      expect(await drift({ target }), target).toMatch(/CHECK/);
    expect(await drift({ resolved_at: now })).toMatch(/CHECK/);
    const id = f.ids.id();
    expect(
      await insert('idp_drift', {
        id,
        run_id: 'r1',
        subject: 's',
        target: 'g:staff_x',
        kind: 'owner_removed',
        found_at: now,
      }),
    ).toBeNull();
    expect(await update('idp_drift', "kind = 'missing'", 'id = ?', [id])).toMatch(/immutable/);
    expect(
      await update('idp_drift', "resolved_at = ?, resolution = 'applied'", 'id = ?', [now, id]),
    ).toBeNull();
    expect(await update('idp_drift', "resolution = 'again'", 'id = ?', [id])).toMatch(/immutable/);
    expect(await refused('DELETE FROM idp_drift WHERE id = ?', [id])).toMatch(/immutable/);
  });

  it('a target state takes a role or a group target and one row per subject and target', async () => {
    const state = (target: string) => insert('idp_target_state', { subject: 'st', target });
    expect(await state('platform_admin')).toMatch(/CHECK/);
    expect(await state('console')).toBeNull();
    expect(await state('console')).toMatch(/UNIQUE/);
    expect(await state('g:ok_group')).toBeNull();
    expect(
      await insert('idp_target_state', { subject: 'st', target: 'support', presence: 'owner' }),
    ).toMatch(/CHECK/);
  });
});

describe('rails on the developer tables', () => {
  it('a sponsorship belongs to the org of its invitation', async () => {
    const org = await standardOrg(f);
    const other = await standardOrg(f);
    const p = await person(f);
    const invitation = await developerInvitation(f, org.id, p.id);
    const sponsor = (orgId: string) =>
      insert(
        'developer_sponsors',
        row({
          org_id: orgId,
          user_id: p.id,
          invitation_id: invitation,
          idp_subject: p.subject,
          group_source: 'signup',
          created_at: now,
        }),
      );
    expect(await sponsor(other.id)).toMatch(/sponsor org differs/);
    expect(await sponsor(org.id)).toBeNull();
  });

  it('a paired org invitation has the same org and address', async () => {
    const org = await standardOrg(f);
    const other = await standardOrg(f);
    const p = await person(f);
    const make = (email: string, paired: string, orgId = org.id) =>
      insert(
        'developer_invitations',
        row({
          org_id: orgId,
          email,
          token_hash: f.ids.token(),
          org_invitation_id: paired,
          created_by_user: p.id,
          created_at: now,
          expires_at: now + 10,
          claim_until: now + 10,
        }),
      );
    const inv = await orgInvitation(f, org.id, 'same@example.test');
    expect(await make('other@example.test', inv)).toMatch(/paired invitation differs/);
    expect(await make('same@example.test', inv, other.id)).toMatch(/paired invitation differs/);
    expect(await make('same@example.test', inv)).toBeNull();
  });
});

describe('idp_dirty', () => {
  it('has one row per subject', async () => {
    await run(db(), 'INSERT INTO idp_dirty (subject) VALUES (?)', ['dirty-once']);
    expect(await insert('idp_dirty', { subject: 'dirty-once' })).toMatch(/UNIQUE/);
  });
});
