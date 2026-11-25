import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../../platform/db.ts';
import { createServiceContext } from '../../../platform/service-context.ts';
import { readSystemValue } from '../../settings/repo.ts';
import { clearMarks, marked } from '../access-test-fixtures.ts';
import { drainIdp } from '../jobs.ts';
import {
  challenge,
  DAY,
  developerInvite,
  memberInvite,
  person,
  post,
  type Rig,
  rig,
  teardown,
} from './invitations-test-fixtures.ts';

let r: Rig;
beforeEach(async () => {
  r = await rig();
  // The suite's database outlives a test and every test starts at the same time: the sweep's mark starts clean.
  await run(r.h.env.DB, "DELETE FROM settings WHERE scope = 'system' AND key = 'idp.invite_sweep'");
});
afterEach(teardown);

const drain = () => drainIdp(createServiceContext(r.h.env, { clock: r.h.clock }));
const made = async (secret: string, subject: string, email = 'stranger@elsewhere.test') => {
  await post(r, '/setup', challenge(secret));
  const ids = [...r.idp.signups.keys()];
  const id = ids.at(-1) as string;
  r.idp.completeSignup(id, subject, { email, emailVerified: true });
  // Polaris ID puts the token's groups on the account when it is made; the fake does so at proof.
  for (const target of r.idp.signups.get(id)?.targets ?? [])
    r.idp.accounts.get(subject)?.roles.add(target);
};

describe('the setup sweep', () => {
  it('takes back the groups of an account made from an invitation nobody accepted', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    await made(invite.secret, 'sub-stranger');
    r.h.clock.advance(7 * DAY + DAY / 2);
    await drain();
    expect(r.idp.accounts.get('sub-stranger')?.roles.has('console')).toBe(true);
    r.h.clock.advance(DAY);
    await clearMarks(['sub-stranger']);
    await drain();
    expect(r.idp.accounts.get('sub-stranger')?.roles.has('console')).toBe(false);
    expect(await marked(['sub-stranger'])).toEqual([]);
    expect(await readSystemValue(r.h.env.DB, 'idp.invite_sweep')).toBeGreaterThan(
      r.h.clock.now() - 2 * DAY,
    );
  });

  it('does it for a revoked developer invitation, once its last token has expired', async () => {
    const invite = await developerInvite(r, 'dev@agency.test', { roles: ['read_only'] });
    await made(invite.secret, 'sub-dev');
    await r.h.env.DB.prepare('UPDATE developer_invitations SET revoked_at = ? WHERE id = ?')
      .bind(r.h.clock.now(), invite.id)
      .run();
    await drain();
    // The token is still good for an hour: nothing is swept yet.
    expect(r.idp.accounts.get('sub-dev')?.roles.has('developer')).toBe(true);
    r.h.clock.advance(3_600_000 + 300_000);
    await drain();
    await drain();
    expect([...(r.idp.accounts.get('sub-dev')?.roles ?? [])]).toEqual([]);
  });

  it('leaves an accepted invitation and its account alone', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const p = await person(r, 'agent@agency.test');
    await made(invite.secret, p.subject, 'agent@agency.test');
    expect((await post(r, '/accept', { token: invite.secret }, p.session.headers)).status).toBe(
      200,
    );
    r.h.clock.advance(9 * DAY);
    await drain();
    expect(r.idp.accounts.get(p.subject)?.roles.has('console')).toBe(true);
  });

  it('does nothing in dry run and keeps the invitation for the next live run', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    await made(invite.secret, 'sub-stranger');
    r.h.clock.advance(9 * DAY);
    r.idp.mode = 'dry_run';
    await drain();
    expect(r.idp.accounts.get('sub-stranger')?.roles.has('console')).toBe(true);
    expect(r.idp.log).not.toContain('proveSignup');
    r.idp.mode = 'live';
    await drain();
    await drain();
    expect(r.idp.accounts.get('sub-stranger')?.roles.has('console')).toBe(false);
  });

  it('stops at an invitation Polaris ID could not answer for, and picks it up again', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    await made(invite.secret, 'sub-stranger');
    r.h.clock.advance(9 * DAY);
    r.idp.failNext('IDP_UPSTREAM', 'proveSignup');
    await drain();
    expect(r.idp.accounts.get('sub-stranger')?.roles.has('console')).toBe(true);
    await drain();
    await drain();
    expect(r.idp.accounts.get('sub-stranger')?.roles.has('console')).toBe(false);
  });
});
