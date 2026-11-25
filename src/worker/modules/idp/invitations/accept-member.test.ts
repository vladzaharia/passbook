import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/helpers/denial.ts';
import { removeFakeIdp } from '../../../../../test/helpers/fake-idp.ts';
import { makeSession } from '../../../../../test/helpers/index.ts';
import { run } from '../../../platform/db.ts';
import { f } from '../../api-keys/test-kit.ts';
import {
  challenge,
  memberInvite,
  oneOf,
  person,
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

const accept = (secret: string, headers: Record<string, string>) =>
  post(r, '/accept', { token: secret }, headers);

describe('POST /invitations/accept, member', () => {
  it('joins the org for the person who holds the invited address, once', async () => {
    const invite = await memberInvite(r, 'agent@agency.test', { roles: ['pass_operator'] });
    const p = await person(r, 'agent@agency.test');
    const res = await accept(invite.secret, p.session.headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcome: string;
      kind: string;
      membership: { roles: string[]; userId: string };
    };
    expect(body).toMatchObject({
      outcome: 'joined',
      kind: 'member',
      membership: { roles: ['pass_operator'], userId: p.user.id },
    });
    expect(
      await oneOf(r, 'SELECT accepted_at FROM org_invitations WHERE id = ?', [invite.id]),
    ).toMatchObject({
      accepted_at: r.h.clock.now(),
    });
    const audits = await rowsOf(
      r,
      'SELECT action FROM audit_log WHERE org_id = ? AND actor_id = ? ORDER BY id',
      [r.orgId, p.user.id],
    );
    expect(audits.map((a) => a.action)).toEqual(['org_invitation.accept', 'org_membership.create']);
    // A member invitation is single use: the same person asking again is refused, and nothing is made twice.
    await expectProblem(await accept(invite.secret, p.session.headers), 400, 'INVITATION_INVALID');
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_memberships WHERE invitation_id = ?', [invite.id]),
    ).toHaveLength(1);
    const stranger = await person(r, 'stranger@agency.test');
    await expectProblem(
      await accept(invite.secret, stranger.session.headers),
      400,
      'INVITATION_INVALID',
    );
  });

  it('refuses a person without the invited address verified, saying only a hint of it', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const p = await person(r, 'someone-else@agency.test');
    const res = await accept(invite.secret, p.session.headers);
    await expectProblem(res, 403, 'INVITATION_EMAIL_MISMATCH');
    const text = JSON.stringify(await res.clone().json());
    expect(text).toContain('a•••@agency.test');
    expect(text).not.toContain('agent@agency.test');
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_memberships WHERE invitation_id = ?', [invite.id]),
    ).toHaveLength(0);
  });

  it('wants a Polaris ID session and a CSRF token', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const p = await person(r, 'agent@agency.test');
    const byEmail = await makeSession(f(), { userId: p.user.id, amr: 'magic_link' });
    const refused = await accept(invite.secret, byEmail.headers);
    await expectProblem(refused, 403, 'IDP_SIGN_IN_REQUIRED');
    expect(JSON.stringify(await refused.clone().json())).toContain('/invite');
    const { 'x-csrf-token': _csrf, ...bare } = p.session.headers;
    expect((await accept(invite.secret, bare)).status).toBe(403);
    expect((await post(r, '/accept', { token: invite.secret })).status).toBe(401);
  });

  it('refuses an expired, a revoked and an unknown invitation', async () => {
    const p = await person(r, 'agent@agency.test');
    const expired = await memberInvite(r, 'agent@agency.test', { expiresIn: 1000 });
    r.h.clock.advance(2000);
    await expectProblem(await accept(expired.secret, p.session.headers), 400, 'INVITATION_INVALID');
    const revoked = await memberInvite(r, 'agent@agency.test');
    await run(r.h.env.DB, 'UPDATE org_invitations SET revoked_at = ? WHERE id = ?', [
      r.h.clock.now(),
      revoked.id,
    ]);
    await expectProblem(await accept(revoked.secret, p.session.headers), 400, 'INVITATION_INVALID');
    await expectProblem(
      await accept(`m_${'z'.repeat(43)}`, p.session.headers),
      400,
      'INVITATION_INVALID',
    );
  });

  it('proves an account made from a signup token, so the binding knows it is ours', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const p = await person(r, 'agent@agency.test');
    await post(r, '/setup', challenge(invite.secret));
    const [tokenId] = [...r.idp.signups.keys()];
    r.idp.completeSignup(tokenId as string, p.subject);
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
    const made = r.idp.accounts.get(p.subject);
    expect([...(made?.grants ?? [])]).toEqual(['console']);
  });

  it('proves nothing when no token was made, and still joins (the plain path needs no Polaris ID)', async () => {
    removeFakeIdp(r.h.env);
    const invite = await memberInvite(r, 'agent@agency.test');
    const p = await person(r, 'agent@agency.test');
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
    expect(r.idp.log).not.toContain('proveSignup');
  });

  it('stops before joining when tokens exist and Polaris ID cannot answer', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const p = await person(r, 'agent@agency.test');
    await post(r, '/setup', challenge(invite.secret));
    r.idp.failNext('IDP_UPSTREAM', 'proveSignup');
    await expectProblem(await accept(invite.secret, p.session.headers), 503, 'IDP_UNAVAILABLE');
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_memberships WHERE invitation_id = ?', [invite.id]),
    ).toHaveLength(0);
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
  });

  it('serves the old landing address as a redirect that keeps the fragment, and the old accept call', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const page = await r.h.call('/api/v1/orgs/invitations/accept', { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/invite');
    const p = await person(r, 'agent@agency.test');
    const legacy = await r.h.call('/api/v1/orgs/invitations/accept', {
      method: 'POST',
      headers: p.session.headers,
      json: { token: invite.secret },
    });
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ orgId: r.orgId, userId: p.user.id });
  });
});
