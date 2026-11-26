import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/helpers/denial.ts';
import { run } from '../../../platform/db.ts';
import { createServiceContext } from '../../../platform/service-context.ts';
import { clearMarks, marked } from '../access-test-fixtures.ts';
import { drainIdp } from '../jobs.ts';
import {
  challenge,
  DAY,
  oneOf,
  person,
  post,
  type Rig,
  rig,
  rowsOf,
  teardown,
} from './invitations-test-fixtures.ts';
import { customGroup, platformInvite } from './platform-test-fixtures.ts';

let r: Rig;
beforeEach(async () => {
  r = await rig();
  await run(
    r.h.env.DB,
    "DELETE FROM settings WHERE scope = 'system' AND key IN ('idp.invite_sweep', 'idp.invite_token_sweep')",
  );
});
afterEach(teardown);

const confirm = (secret: string) => post(r, '/confirm', { token: secret });
const drain = () => drainIdp(createServiceContext(r.h.env, { clock: r.h.clock }));
/** The person made a Polaris ID from the setup link, with this address, verified or not. */
const signUp = async (secret: string, subject: string, email: string, emailVerified = true) => {
  expect((await post(r, '/setup', challenge(secret))).status).toBe(200);
  const id = [...r.idp.signups.keys()].at(-1) as string;
  r.idp.completeSignup(id, subject, { email, emailVerified });
};
const members = (id: string) =>
  rowsOf(
    r,
    'SELECT group_key, subject, user_id, source FROM idp_group_members WHERE platform_invitation_id = ? ORDER BY group_key',
    [id],
  );
const accepted = (id: string) =>
  oneOf(r, 'SELECT accepted_at, accepted_subject FROM platform_invitations WHERE id = ?', [id]);

describe('POST /invitations/preview, platform', () => {
  it('names the groups and the masked address, and says Polaris ID can be used', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key], developer: true });
    const res = await post(r, '/preview', { token: invite.secret });
    expect(await res.json()).toMatchObject({
      kind: 'platform',
      orgName: null,
      groups: [`Group ${key}`],
      roles: [],
      developer: true,
      polaris: true,
    });
    expect(
      JSON.stringify(await post(r, '/preview', { token: invite.secret }).then((x) => x.json())),
    ).not.toContain('guest@');
  });

  it('is invalid when revoked or past its window, and not polaris while Polaris ID is in dry run', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    r.idp.mode = 'dry_run';
    expect(await (await post(r, '/preview', { token: invite.secret })).json()).toMatchObject({
      polaris: false,
    });
    r.idp.mode = 'live';
    r.h.clock.advance(8 * DAY + 1);
    await expectProblem(
      await post(r, '/preview', { token: invite.secret }),
      400,
      'INVITATION_INVALID',
    );
  });
});

describe('setup', () => {
  it('mints a one-hour token carrying the groups, and developer when chosen', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key], developer: true });
    const res = await post(r, '/setup', challenge(invite.secret));
    expect(res.status).toBe(200);
    const token = [...r.idp.signups.values()].at(-1);
    expect([...(token?.targets ?? [])].sort()).toEqual(['developer', `g:${key}`]);
    expect(
      await rowsOf(r, 'SELECT * FROM platform_invitation_setups WHERE invitation_id = ?', [
        invite.id,
      ]),
    ).toHaveLength(1);
  });

  it('is refused in dry run and a fourth link is capped', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    r.idp.mode = 'dry_run';
    expect((await post(r, '/setup', challenge(invite.secret))).status).toBe(503);
    r.idp.mode = 'live';
    for (let i = 0; i < 3; i++) {
      expect((await post(r, '/setup', challenge(invite.secret))).status).toBe(200);
      r.h.clock.advance(1000);
    }
    await expectProblem(
      await post(r, '/setup', challenge(invite.secret)),
      429,
      'INVITATION_SETUP_CAPPED',
    );
  });
});

describe('POST /invitations/confirm', () => {
  it('match: accepts, writes invitation memberships for the account, and answers again', async () => {
    const [a, b] = [await customGroup(r), await customGroup(r)];
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [a, b] });
    await signUp(invite.secret, 'sub-guest', invite.email);
    const res = await confirm(invite.secret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'joined' });
    expect(await accepted(invite.id)).toMatchObject({ accepted_subject: 'sub-guest' });
    expect(await members(invite.id)).toMatchObject([
      { group_key: a, subject: 'sub-guest', user_id: null, source: 'invitation' },
      { group_key: b, subject: 'sub-guest', source: 'invitation' },
    ]);
    expect(await marked(['sub-guest'])).toEqual(['sub-guest']);
    expect(
      await oneOf(
        r,
        "SELECT detail FROM audit_log WHERE action = 'idp.invite_platform' AND target_id = ? AND detail LIKE '%accept%'",
        [invite.id],
      ),
    ).not.toBeNull();
    expect(await (await confirm(invite.secret)).json()).toEqual({ outcome: 'joined' });
    // The account keeps the groups through the drain: the rows are the reason now.
    await clearMarks(['sub-guest']);
    await drain();
    expect(r.idp.accounts.get('sub-guest')?.roles.has(`g:${a}`)).toBe(true);
  });

  it('unverified: asks to confirm the email and accepts nothing', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    await signUp(invite.secret, 'sub-unverified', invite.email, false);
    await expectProblem(await confirm(invite.secret), 409, 'INVITATION_EMAIL_UNVERIFIED');
    expect((await accepted(invite.id))?.accepted_at).toBeNull();
    expect(await members(invite.id)).toEqual([]);
    // After verifying, trying again works.
    const account = r.idp.accounts.get('sub-unverified');
    if (account) account.emailVerified = true;
    expect((await confirm(invite.secret)).status).toBe(200);
  });

  it('mismatch: says so, accepts nothing and takes the groups back', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    // A forwarded link: someone else makes the account, with their own address.
    await signUp(invite.secret, 'sub-stranger', r.addr('stranger@elsewhere.test'));
    expect(r.idp.accounts.get('sub-stranger')?.roles.has(`g:${key}`)).toBe(false);
    await post(r, '/preview', { token: invite.secret });
    const res = await confirm(invite.secret);
    await expectProblem(res, 403, 'INVITATION_EMAIL_MISMATCH');
    expect((await accepted(invite.id))?.accepted_at).toBeNull();
    expect(await members(invite.id)).toEqual([]);
    expect(await marked(['sub-stranger'])).toEqual(['sub-stranger']);
    await drain();
    expect(r.idp.accounts.get('sub-stranger')?.roles.has(`g:${key}`)).toBe(false);
  });

  it('answers that the Polaris ID is not made yet, and refuses other kinds and revoked invitations', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    await expectProblem(await confirm(invite.secret), 409, 'INVITATION_NOT_STARTED');
    await expectProblem(await confirm(`m_${'a'.repeat(43)}`), 400, 'INVITATION_INVALID');
    await run(r.h.env.DB, 'UPDATE platform_invitations SET revoked_at = ? WHERE id = ?', [
      r.h.clock.now(),
      invite.id,
    ]);
    await expectProblem(await confirm(invite.secret), 400, 'INVITATION_INVALID');
  });

  it('a developer invitation needs a PassBook sign-in', async () => {
    const invite = await platformInvite(r, 'guest@agency.test', { developer: true });
    await signUp(invite.secret, 'sub-dev', invite.email);
    await expectProblem(await confirm(invite.secret), 403, 'IDP_SIGN_IN_REQUIRED');
  });

  it('a forwarded link accepted by the invitee first: the stranger who used it loses the groups', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    await signUp(invite.secret, 'sub-stranger', r.addr('stranger@elsewhere.test'));
    r.h.clock.advance(1000);
    await signUp(invite.secret, 'sub-guest', invite.email);
    expect((await confirm(invite.secret)).status).toBe(200);
    expect(await accepted(invite.id)).toMatchObject({ accepted_subject: 'sub-guest' });
    expect(await marked(['sub-stranger', 'sub-guest']).then((m) => m.sort())).toEqual([
      'sub-guest',
      'sub-stranger',
    ]);
  });
});

describe('POST /invitations/claim-existing, platform', () => {
  const account = (email: string, subject: string, verified = true) =>
    r.idp.addAccount(subject, { email, emailVerified: verified });

  it('gives the account with the invited address the groups and accepts at once, with no sign-in', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    account(invite.email, 'sub-existing');
    account(r.addr('other@elsewhere.test'), 'sub-other');
    const res = await post(r, '/claim-existing', challenge(invite.secret));
    expect(res.status).toBe(200);
    expect(r.idp.accounts.get('sub-existing')?.grants.has(`g:${key}`)).toBe(true);
    expect(r.idp.accounts.get('sub-other')?.roles.size).toBe(0);
    expect(await accepted(invite.id)).toMatchObject({ accepted_subject: 'sub-existing' });
    expect(await members(invite.id)).toMatchObject([{ group_key: key, subject: 'sub-existing' }]);
    expect(
      await rowsOf(r, 'SELECT subject FROM idp_invite_claims WHERE platform_invitation_id = ?', [
        invite.id,
      ]),
    ).toEqual([{ subject: 'sub-existing' }]);
  });

  it('says there is no account, and does not find an unverified one', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    account(invite.email, 'sub-unverified', false);
    await expectProblem(
      await post(r, '/claim-existing', challenge(invite.secret)),
      404,
      'INVITATION_NO_ACCOUNT',
    );
    expect((await accepted(invite.id))?.accepted_at).toBeNull();
  });

  it('with developer access gives the groups now and waits for the sign-in', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key], developer: true });
    account(invite.email, 'sub-existing');
    expect((await post(r, '/claim-existing', challenge(invite.secret))).status).toBe(200);
    expect([...(r.idp.accounts.get('sub-existing')?.grants ?? [])].sort()).toEqual([
      'developer',
      `g:${key}`,
    ]);
    expect((await accepted(invite.id))?.accepted_at).toBeNull();
  });
});

describe('POST /invitations/accept, platform developer', () => {
  const accept = (secret: string, headers: Record<string, string>) =>
    post(r, '/accept', { token: secret }, headers);

  it('writes the developer grant and the group rows for the signed-in person, and answers again', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key], developer: true });
    const p = await person(r, 'guest@agency.test', ['user', 'developer']);
    await signUp(invite.secret, p.subject, invite.email);
    const res = await accept(invite.secret, p.session.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      outcome: 'joined',
      kind: 'platform',
      orgName: null,
      membership: null,
    });
    expect(await accepted(invite.id)).toMatchObject({ accepted_subject: p.subject });
    expect(await members(invite.id)).toMatchObject([
      { group_key: key, subject: p.subject, user_id: p.user.id, source: 'invitation' },
    ]);
    expect(
      await rowsOf(
        r,
        'SELECT role, granted_by FROM platform_role_grants WHERE user_id = ? AND revoked_at IS NULL',
        [p.user.id],
      ),
    ).toMatchObject([{ role: 'developer' }]);
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
  });

  it('refuses a session without the invited address, and another person after the accept', async () => {
    const invite = await platformInvite(r, 'guest@agency.test', { developer: true });
    const wrong = await person(r, 'someone@else.test', ['user']);
    await expectProblem(
      await accept(invite.secret, wrong.session.headers),
      403,
      'INVITATION_EMAIL_MISMATCH',
    );
    const p = await person(r, 'guest@agency.test', ['user', 'developer']);
    await signUp(invite.secret, p.subject, invite.email);
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
    await expectProblem(
      await accept(invite.secret, wrong.session.headers),
      400,
      'INVITATION_INVALID',
    );
  });

  it('claims an existing account that has the address, then accepts', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key], developer: true });
    const p = await person(r, 'guest@agency.test', ['user']);
    r.idp.addAccount(p.subject, { email: invite.email, emailVerified: true });
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
    expect([...(r.idp.accounts.get(p.subject)?.grants ?? [])].sort()).toEqual([
      'developer',
      `g:${key}`,
    ]);
  });

  it('is only for developer invitations', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    const p = await person(r, 'guest@agency.test', ['user']);
    await expectProblem(await accept(invite.secret, p.session.headers), 400, 'INVITATION_INVALID');
  });
});

describe('the setup sweep, platform', () => {
  it('finishes an invitation whose person made a Polaris ID and never pressed Done', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    await signUp(invite.secret, 'sub-guest', invite.email);
    r.h.clock.advance(3 * 60 * 60 * 1000);
    await drain();
    expect(await accepted(invite.id)).toMatchObject({ accepted_subject: 'sub-guest' });
    expect(await members(invite.id)).toMatchObject([{ group_key: key, subject: 'sub-guest' }]);
  });

  it('takes the groups back from an account with another address', async () => {
    const key = await customGroup(r);
    const invite = await platformInvite(r, 'guest@agency.test', { groups: [key] });
    await signUp(invite.secret, 'sub-stranger', r.addr('stranger@elsewhere.test'));
    // Polaris ID puts the token's groups on the account when it is made; the fake does so at proof.
    r.idp.accounts.get('sub-stranger')?.roles.add(`g:${key}`);
    r.h.clock.advance(3 * 60 * 60 * 1000);
    await drain();
    expect((await accepted(invite.id))?.accepted_at).toBeNull();
    expect(r.idp.accounts.get('sub-stranger')?.roles.has(`g:${key}`)).toBe(false);
  });

  it('does not accept a developer invitation on its own', async () => {
    const invite = await platformInvite(r, 'guest@agency.test', { developer: true });
    await signUp(invite.secret, 'sub-dev', invite.email);
    r.h.clock.advance(3 * 60 * 60 * 1000);
    await drain();
    expect((await accepted(invite.id))?.accepted_at).toBeNull();
  });
});
