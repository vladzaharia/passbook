import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/helpers/denial.ts';
import { setLimit } from '../../../../../test/helpers/limits.ts';
import { run } from '../../../platform/db.ts';
import { createServiceContext } from '../../../platform/service-context.ts';
import { fakeLimiter } from '../../auth/test-support.ts';
import { claimAccount } from './claim-existing.ts';
import {
  challenge,
  developerInvite,
  memberInvite,
  person,
  post,
  type Rig,
  rig,
  rowsOf,
  teardown,
} from './invitations-test-fixtures.ts';
import { resolveInvite } from './resolve.ts';

let r: Rig;
beforeEach(async () => {
  r = await rig();
});
afterEach(teardown);

const limiter = (max: number) => fakeLimiter(max) as unknown as RateLimit;

describe('claim-existing is bounded per invitation', () => {
  it('searches the directory once, then answers from the open claim; a fourth call in a minute is limited', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    r.idp.addAccount('sub-e', { email: invite.email, emailVerified: true });
    r.h.env.RL_MAGIC_LINK = limiter(3);
    for (let i = 0; i < 3; i++)
      expect((await post(r, '/claim-existing', challenge(invite.secret))).status).toBe(200);
    expect(r.idp.log.filter((m) => m === 'findByVerifiedEmail')).toHaveLength(1);
    expect(r.idp.log.filter((m) => m === 'apply')).toHaveLength(1);
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      429,
      'RATE_LIMITED',
    );
  });

  it('a repeat for an account at the three-claim cap changes nothing and does not fail', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    for (const n of [1, 2, 3])
      await run(
        r.h.env.DB,
        'INSERT INTO idp_invite_claims (id, org_invitation_id, subject, created_at, claim_until) VALUES (?, ?, ?, ?, ?)',
        [
          `claim-h-${r.addr(String(n))}`,
          invite.id,
          `sub-${n}`,
          r.h.clock.now(),
          r.h.clock.now() + 1000,
        ],
      );
    r.idp.addAccount('sub-3', { email: invite.email, emailVerified: true });
    const ctx = createServiceContext(r.h.env, { clock: r.h.clock });
    const resolved = await resolveInvite(ctx, invite.secret);
    await claimAccount(ctx, resolved as NonNullable<typeof resolved>, 'sub-3');
    expect(
      await rowsOf(r, 'SELECT 1 FROM idp_invite_claims WHERE org_invitation_id = ?', [invite.id]),
    ).toHaveLength(3);
  });
});

describe('claim-existing with no account for the address', () => {
  it('searches once, remembers the answer for ten minutes, and searches at most five times a day', async () => {
    const invite = await memberInvite(r, 'nobody@agency.test');
    const search = () => r.idp.log.filter((m) => m === 'findByVerifiedEmail').length;
    for (let i = 0; i < 30; i++)
      await expectProblem(
        await post(r, '/claim-existing', challenge(invite.secret)),
        404,
        'INVITATION_NO_ACCOUNT',
      );
    expect(search()).toBe(1);
    // After the memory ends a search runs again, but never more than five in a day: the rest answer the same.
    for (let i = 0; i < 12; i++) {
      r.h.clock.advance(11 * 60_000);
      await expectProblem(
        await post(r, '/claim-existing', challenge(invite.secret)),
        404,
        'INVITATION_NO_ACCOUNT',
      );
    }
    expect(search()).toBe(5);
    // Many invitations of one link holder's making cost the binding one search each, not one per call.
    const other = await memberInvite(r, 'other@agency.test');
    for (let i = 0; i < 10; i++) await post(r, '/claim-existing', challenge(other.secret));
    expect(search()).toBe(6);
  });

  it('still finds an account that appears later, once the memory ends', async () => {
    const invite = await memberInvite(r, 'late@agency.test');
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      404,
      'INVITATION_NO_ACCOUNT',
    );
    r.idp.addAccount('sub-late', { email: invite.email, emailVerified: true });
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      404,
      'INVITATION_NO_ACCOUNT',
    );
    r.h.clock.advance(11 * 60_000);
    expect((await post(r, '/claim-existing', challenge(invite.secret))).status).toBe(200);
  });
});

describe('the Polaris ID gate', () => {
  const polaris = async (secret: string) =>
    ((await (await post(r, '/preview', { token: secret })).json()) as { polaris: boolean }).polaris;

  it('needs the console group to be the one sign-in reads', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    expect(await polaris(invite.secret)).toBe(true);
    r.h.env.OIDC_ADMIN_GROUP = 'someone_else';
    expect(await polaris(invite.secret)).toBe(false);
  });

  it('accepts the group when sign-in lists it among several names, as production does', async () => {
    const member = await memberInvite(r, 'agent@agency.test');
    const paired = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    // Production values: the admin group is a list holding the binding's console group.
    r.h.env.OIDC_ADMIN_GROUP = 'wallet_org_admins,passbook_console';
    r.h.env.OIDC_PLATFORM_ADMIN_GROUP = 'wallet_admins,passbook_admins';
    r.h.env.OIDC_DEVELOPER_GROUP = 'wallet_developers, passbook_developers';
    expect(await polaris(member.secret)).toBe(true);
    expect(await polaris(paired.secret)).toBe(true);
    // A list that does not name the binding's group is refused, near misses included.
    r.h.env.OIDC_ADMIN_GROUP = 'wallet_org_admins,passbook_console_old';
    expect(await polaris(member.secret)).toBe(false);
    expect(await polaris(paired.secret)).toBe(false);
    r.h.env.OIDC_ADMIN_GROUP = 'passbook_console';
    r.h.env.OIDC_DEVELOPER_GROUP = 'wallet_developers,passbook_developers_old';
    expect(await polaris(paired.secret)).toBe(false);
    expect(await polaris(member.secret)).toBe(true);
  });
});

describe('setup', () => {
  it('two setups racing leave one live token', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const both = await Promise.all([
      post(r, '/setup', challenge(invite.secret)),
      post(r, '/setup', challenge(invite.secret)),
    ]);
    expect(both.map((x) => x.status)).toEqual([200, 200]);
    expect(r.idp.signups.size).toBe(1);
  });
});

describe('the legacy accept address', () => {
  it('is limited per user like the new one', async () => {
    const p = await person(r, 'agent@agency.test');
    const a = await memberInvite(r, 'agent@agency.test');
    const b = await memberInvite(r, 'agent@agency.test');
    r.h.env.RL_LOGIN = limiter(1);
    const legacy = (secret: string) =>
      r.h.call('/api/v1/orgs/invitations/accept', {
        method: 'POST',
        headers: p.session.headers,
        json: { token: secret },
      });
    expect((await legacy(a.secret)).status).toBe(200);
    await expectProblem(await legacy(b.secret), 429, 'RATE_LIMITED');
  });
});

describe('an accept that fails after its gate lands leaves nothing behind', () => {
  const ignoring = (name: string, table: string) =>
    run(
      r.h.env.DB,
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
    );
  const drop = (name: string) => run(r.h.env.DB, `DROP TRIGGER ${name}`);

  it('a developer accept whose sponsorship is silently dropped', async () => {
    await setLimit(r.h.env.DB, r.orgId, 'members.developers', 5);
    const invite = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    await ignoring('t_inv_skip_sponsor', 'developer_sponsors');
    try {
      await expectProblem(
        await post(r, '/accept', { token: invite.secret }, p.session.headers),
        409,
        'INVITATION_CONFLICT',
      );
    } finally {
      await drop('t_inv_skip_sponsor');
    }
    expect(
      await rowsOf(r, 'SELECT 1 FROM developer_invitations WHERE id = ? AND accepted_at IS NULL', [
        invite.id,
      ]),
    ).toHaveLength(1);
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_invitations WHERE id = ? AND accepted_at IS NULL', [
        invite.memberId as string,
      ]),
    ).toHaveLength(1);
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_memberships WHERE user_id = ?', [p.user.id]),
    ).toHaveLength(0);
    expect(
      await rowsOf(r, "SELECT 1 FROM audit_log WHERE actor_id = ? AND action LIKE '%accept%'", [
        p.user.id,
      ]),
    ).toHaveLength(0);
  });

  it('a member accept whose membership is silently dropped', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const p = await person(r, 'agent@agency.test');
    await ignoring('t_inv_skip_membership', 'org_memberships');
    try {
      await expectProblem(
        await post(r, '/accept', { token: invite.secret }, p.session.headers),
        400,
        'INVITATION_INVALID',
      );
    } finally {
      await drop('t_inv_skip_membership');
    }
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_invitations WHERE id = ? AND accepted_at IS NULL', [
        invite.id,
      ]),
    ).toHaveLength(1);
    expect(
      await rowsOf(r, "SELECT 1 FROM audit_log WHERE actor_id = ? AND action LIKE '%accept%'", [
        p.user.id,
      ]),
    ).toHaveLength(0);
    // The invitation is still open: the same person joins once the fault is gone.
    expect((await post(r, '/accept', { token: invite.secret }, p.session.headers)).status).toBe(
      200,
    );
  });
});
