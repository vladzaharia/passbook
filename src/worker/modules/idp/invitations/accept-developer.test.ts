import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../../test/helpers/index.ts';
import { setLimit } from '../../../../../test/helpers/limits.ts';
import { run } from '../../../platform/db.ts';
import { f } from '../../api-keys/test-kit.ts';
import {
  challenge,
  DAY,
  developerInvite,
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
  await setLimit(r.h.env.DB, r.orgId, 'members.developers', 5);
});
afterEach(teardown);

const accept = (secret: string, headers: Record<string, string>) =>
  post(r, '/accept', { token: secret }, headers);
const sponsors = () => rowsOf(r, 'SELECT * FROM developer_sponsors WHERE org_id = ?', [r.orgId]);

describe('POST /invitations/accept, developer', () => {
  it('after a signup made here: sponsors the person and makes the paired membership in one batch', async () => {
    const invite = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    await post(r, '/setup', challenge(invite.secret));
    r.idp.completeSignup([...r.idp.signups.keys()][0] as string, p.subject);
    const res = await accept(invite.secret, p.session.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      outcome: 'joined',
      kind: 'developer',
      membership: { roles: ['read_only'], userId: p.user.id },
    });
    expect(await sponsors()).toMatchObject([
      {
        user_id: p.user.id,
        idp_subject: p.subject,
        group_source: 'signup',
        invitation_id: invite.id,
      },
    ]);
    expect(
      await oneOf(
        r,
        'SELECT accepted_user_id, accepted_at FROM developer_invitations WHERE id = ?',
        [invite.id],
      ),
    ).toMatchObject({
      accepted_user_id: p.user.id,
      accepted_at: r.h.clock.now(),
    });
    expect(
      await oneOf(r, 'SELECT accepted_at FROM org_invitations WHERE id = ?', [
        invite.memberId as string,
      ]),
    ).toMatchObject({ accepted_at: r.h.clock.now() });
    const audits = await rowsOf(
      r,
      'SELECT action, detail FROM audit_log WHERE org_id = ? AND actor_id = ? ORDER BY id',
      [r.orgId, p.user.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'developer_invitation.accept',
      'org_invitation.accept',
      'org_membership.create',
    ]);
    expect(audits[0]?.detail).toBe('{"path":"signup"}');
    expect([...(r.idp.accounts.get(p.subject)?.grants ?? [])].sort()).toEqual([
      'console',
      'developer',
    ]);
  });

  it('developer access alone makes a sponsorship and no membership', async () => {
    const invite = await developerInvite(r, 'dev@agency.test');
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    await post(r, '/setup', challenge(invite.secret));
    r.idp.completeSignup([...r.idp.signups.keys()][0] as string, p.subject);
    expect(await (await accept(invite.secret, p.session.headers)).json()).toMatchObject({
      outcome: 'joined',
      membership: null,
    });
    expect(await sponsors()).toHaveLength(1);
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_memberships WHERE user_id = ?', [p.user.id]),
    ).toHaveLength(0);
  });

  it('after a claim: records source added', async () => {
    r.idp.addAccount('sub-existing', { email: r.addr('dev@agency.test'), emailVerified: true });
    const invite = await developerInvite(r, 'dev@agency.test');
    await post(r, '/claim-existing', challenge(invite.secret));
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    await run(r.h.env.DB, "UPDATE auth_identities SET subject = 'sub-existing' WHERE user_id = ?", [
      p.user.id,
    ]);
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
    expect(await sponsors()).toMatchObject([
      { group_source: 'added', idp_subject: 'sub-existing' },
    ]);
    expect(r.idp.log.filter((m) => m === 'apply')).toHaveLength(1);
  });

  it('with the developer role already held, records source existing and calls Polaris ID for nothing', async () => {
    const invite = await developerInvite(r, 'dev@agency.test');
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
    expect(await sponsors()).toMatchObject([{ group_source: 'existing' }]);
    expect(r.idp.writes).toBe(0);
  });

  it('without the role or a claim: adds the group now, records a claim and asks for one more sign-in', async () => {
    const invite = await developerInvite(r, 'dev@agency.test');
    const p = await person(r, 'dev@agency.test');
    r.idp.addAccount(p.subject, { email: r.addr('dev@agency.test'), emailVerified: true });
    const res = await accept(invite.secret, p.session.headers);
    expect(await res.json()).toMatchObject({ outcome: 'refresh', membership: null });
    expect(await sponsors()).toMatchObject([{ group_source: 'added', idp_subject: p.subject }]);
    expect([...(r.idp.accounts.get(p.subject)?.roles ?? [])]).toEqual(['developer']);
    expect(
      await rowsOf(r, 'SELECT 1 FROM idp_invite_claims WHERE developer_invitation_id = ?', [
        invite.id,
      ]),
    ).toHaveLength(1);
  });

  it('answers a replay by the same person the same, and a stranger as invalid', async () => {
    const invite = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    await accept(invite.secret, p.session.headers);
    const again = await accept(invite.secret, p.session.headers);
    expect(await again.json()).toMatchObject({
      outcome: 'joined',
      membership: { userId: p.user.id },
    });
    expect(await sponsors()).toHaveLength(1);
    const other = await person(r, 'stranger@agency.test', ['user', 'developer']);
    await expectProblem(
      await accept(invite.secret, other.session.headers),
      400,
      'INVITATION_INVALID',
    );
  });

  it('refuses a wrong address, an email-link session and a paired invitation revoked on its own', async () => {
    const invite = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    const wrong = await person(r, 'x@agency.test', ['user', 'developer']);
    await expectProblem(
      await accept(invite.secret, wrong.session.headers),
      403,
      'INVITATION_EMAIL_MISMATCH',
    );
    await run(r.h.env.DB, 'UPDATE org_invitations SET revoked_at = ? WHERE id = ?', [
      r.h.clock.now(),
      invite.memberId as string,
    ]);
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    await expectProblem(await accept(invite.secret, p.session.headers), 400, 'INVITATION_INVALID');
    expect(await sponsors()).toHaveLength(0);
  });

  it('refuses when the plan has no seat, and leaves nothing half done', async () => {
    await setLimit(r.h.env.DB, r.orgId, 'members.developers', 1);
    const first = await developerInvite(r, 'one@agency.test');
    const a = await person(r, 'one@agency.test', ['user', 'developer']);
    expect((await accept(first.secret, a.session.headers)).status).toBe(200);
    const second = await developerInvite(r, 'two@agency.test', { roles: ['read_only'] });
    const b = await person(r, 'two@agency.test', ['user', 'developer']);
    await expectProblem(
      await accept(second.secret, b.session.headers),
      409,
      'DEVELOPER_LIMIT_REACHED',
    );
    expect(await sponsors()).toHaveLength(1);
    expect(
      await rowsOf(r, 'SELECT 1 FROM developer_invitations WHERE id = ? AND accepted_at IS NULL', [
        second.id,
      ]),
    ).toHaveLength(1);
    expect(
      await rowsOf(r, 'SELECT 1 FROM org_memberships WHERE user_id = ?', [b.user.id]),
    ).toHaveLength(0);
  });

  it('rolls everything back when a part cannot land (the person is already a member)', async () => {
    const invite = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    await run(
      r.h.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at) VALUES ('old', ?, 'dev@agency.test', '["read_only"]', 'h-old', 1, 2, 1)`,
      [r.orgId],
    );
    await run(
      r.h.env.DB,
      "INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES ('old-m', ?, ?, 'old', '[\"read_only\"]', 1)",
      [r.orgId, p.user.id],
    );
    await expectProblem(await accept(invite.secret, p.session.headers), 409, 'INVITATION_CONFLICT');
    expect(await sponsors()).toHaveLength(0);
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
  });

  it('inside the claim window after the invitation expired, still checks the seat limit', async () => {
    await setLimit(r.h.env.DB, r.orgId, 'members.developers', 1);
    const late = await developerInvite(r, 'late@agency.test');
    const p = await person(r, 'late@agency.test', ['user', 'developer']);
    r.h.clock.advance(6.5 * DAY);
    await post(r, '/setup', challenge(late.secret));
    r.idp.completeSignup([...r.idp.signups.keys()][0] as string, p.subject);
    r.h.clock.advance(DAY / 2 + 60_000);
    // Another invitation takes the one seat while this one no longer counts as pending.
    const other = await developerInvite(r, 'other@agency.test');
    const o = await person(r, 'other@agency.test', ['user', 'developer']);
    expect((await accept(other.secret, o.session.headers)).status).toBe(200);
    await expectProblem(
      await accept(late.secret, p.session.headers),
      409,
      'DEVELOPER_LIMIT_REACHED',
    );
    expect(await sponsors()).toHaveLength(1);
  });

  it('accepts inside the claim window after the invitation expired when a seat is free', async () => {
    const invite = await developerInvite(r, 'late@agency.test');
    const p = await person(r, 'late@agency.test', ['user', 'developer']);
    r.h.clock.advance(6.5 * DAY);
    await post(r, '/setup', challenge(invite.secret));
    r.idp.completeSignup([...r.idp.signups.keys()][0] as string, p.subject);
    r.h.clock.advance(DAY / 2 + 60_000);
    expect((await accept(invite.secret, p.session.headers)).status).toBe(200);
    r.h.clock.advance(2 * DAY);
    const gone = await developerInvite(r, 'gone@agency.test', { expiresIn: 1000 });
    r.h.clock.advance(2000);
    const g = await person(r, 'gone@agency.test', ['user', 'developer']);
    await expectProblem(await accept(gone.secret, g.session.headers), 400, 'INVITATION_INVALID');
  });

  it('refuses a sandbox or personal org', async () => {
    const sandbox = await makeOrg(f(), { kind: 'developer' });
    const invite = await developerInvite(r, 'dev@agency.test', { orgId: sandbox.id });
    const p = await person(r, 'dev@agency.test', ['user', 'developer']);
    await expectProblem(await accept(invite.secret, p.session.headers), 400, 'INVITATION_INVALID');
  });
});
