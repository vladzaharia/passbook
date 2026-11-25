import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/helpers/denial.ts';
import { run } from '../../../platform/db.ts';
import { marked } from '../access-test-fixtures.ts';
import {
  challenge,
  DAY,
  developerInvite,
  memberInvite,
  oneOf,
  post,
  type Rig,
  rig,
  rowsOf,
  teardown,
} from './invitations-test-fixtures.ts';

let r: Rig;
beforeEach(async () => {
  r = await rig();
});
afterEach(teardown);

const account = (email: string, subject = 'sub-existing') =>
  r.idp.addAccount(subject, { email: r.addr(email), emailVerified: true });

describe('POST /invitations/claim-existing', () => {
  it('gives the account that has the invited address the groups at once, and records a claim', async () => {
    account('agent@agency.test');
    const invite = await memberInvite(r, 'agent@agency.test');
    const res = await post(r, '/claim-existing', challenge(invite.secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect([...(r.idp.accounts.get('sub-existing')?.roles ?? [])]).toEqual(['console']);
    expect([...(r.idp.accounts.get('sub-existing')?.grants ?? [])]).toEqual(['console']);
    const claim = await oneOf(r, 'SELECT * FROM idp_invite_claims WHERE org_invitation_id = ?', [
      invite.id,
    ]);
    expect(claim).toMatchObject({
      subject: 'sub-existing',
      claim_until: r.h.clock.now() + DAY,
      swept_at: null,
    });
    expect(await marked(['sub-existing'])).toEqual(['sub-existing']);
    const audit = await oneOf(
      r,
      "SELECT actor_type FROM audit_log WHERE action = 'org_invitation.claim' AND org_id = ?",
      [r.orgId],
    );
    expect(audit).toMatchObject({ actor_type: 'system' });
  });

  it('moves a developer invitation window out and gives developer, and console when paired', async () => {
    account('dev@agency.test');
    const invite = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    r.h.clock.advance(6.5 * DAY);
    expect((await post(r, '/claim-existing', challenge(invite.secret))).status).toBe(200);
    expect([...(r.idp.accounts.get('sub-existing')?.roles ?? [])].sort()).toEqual([
      'console',
      'developer',
    ]);
    const row = await oneOf(r, 'SELECT claim_until FROM developer_invitations WHERE id = ?', [
      invite.id,
    ]);
    expect(row?.claim_until).toBe(r.h.clock.now() + DAY);
    const claim = await oneOf(
      r,
      'SELECT claim_until FROM idp_invite_claims WHERE developer_invitation_id = ?',
      [invite.id],
    );
    expect(claim?.claim_until).toBe(r.h.clock.now() + DAY);
  });

  it('answers that no account uses the address, and changes nothing', async () => {
    const invite = await memberInvite(r, 'nobody@agency.test');
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      404,
      'INVITATION_NO_ACCOUNT',
    );
    account('someone-else@agency.test');
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      404,
      'INVITATION_NO_ACCOUNT',
    );
    expect(
      await rowsOf(r, 'SELECT 1 FROM idp_invite_claims WHERE org_invitation_id = ?', [invite.id]),
    ).toHaveLength(0);
    expect(r.idp.writes).toBe(0);
  });

  it('does nothing twice, and stops a fourth account', async () => {
    account('agent@agency.test');
    const invite = await memberInvite(r, 'agent@agency.test');
    await post(r, '/claim-existing', challenge(invite.secret));
    await post(r, '/claim-existing', challenge(invite.secret));
    expect(
      await rowsOf(r, 'SELECT 1 FROM idp_invite_claims WHERE org_invitation_id = ?', [invite.id]),
    ).toHaveLength(1);
    for (const n of [2, 3])
      await run(
        r.h.env.DB,
        'INSERT INTO idp_invite_claims (id, org_invitation_id, subject, created_at, claim_until) VALUES (?, ?, ?, ?, ?)',
        [`claim-${n}`, invite.id, `sub-${n}`, r.h.clock.now(), r.h.clock.now() + DAY],
      );
    r.idp.addAccount('sub-late', { email: r.addr('late@agency.test'), emailVerified: true });
    const late = await memberInvite(r, 'late@agency.test');
    for (const n of [4, 5, 6])
      await run(
        r.h.env.DB,
        'INSERT INTO idp_invite_claims (id, org_invitation_id, subject, created_at, claim_until) VALUES (?, ?, ?, ?, ?)',
        [`claim-${n}`, late.id, `sub-${n}`, r.h.clock.now(), r.h.clock.now() + DAY],
      );
    await expectProblem(
      await post(r, '/claim-existing', challenge(late.secret)),
      429,
      'INVITATION_CLAIM_CAPPED',
    );
  });

  it('is refused for a bad Turnstile answer, in dry run and for an ended invitation', async () => {
    account('agent@agency.test');
    const invite = await memberInvite(r, 'agent@agency.test');
    r.h.turnstileOk.value = false;
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      403,
      'TURNSTILE_FAILED',
    );
    r.h.turnstileOk.value = true;
    r.idp.mode = 'dry_run';
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      503,
      'IDP_UNAVAILABLE',
    );
    r.idp.mode = 'live';
    await run(r.h.env.DB, 'UPDATE org_invitations SET revoked_at = ? WHERE id = ?', [
      r.h.clock.now(),
      invite.id,
    ]);
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      400,
      'INVITATION_INVALID',
    );
    expect(r.idp.writes).toBe(0);
  });

  it('refuses a platform admin account (the binding never writes to one)', async () => {
    r.idp.addAccount('sub-admin', {
      email: r.addr('boss@agency.test'),
      emailVerified: true,
      isAdmin: true,
    });
    const invite = await memberInvite(r, 'boss@agency.test');
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      404,
      'INVITATION_NO_ACCOUNT',
    );
  });
});
