import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../../platform/db.ts';
import { createServiceContext } from '../../../platform/service-context.ts';
import { drainIdp } from '../jobs.ts';
import {
  challenge,
  DAY,
  memberInvite,
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
  await run(
    r.h.env.DB,
    "DELETE FROM settings WHERE scope = 'system' AND key IN ('idp.invite_sweep', 'idp.invite_token_sweep')",
  );
});
afterEach(teardown);

const drain = () => drainIdp(createServiceContext(r.h.env, { clock: r.h.clock }));
const HOUR = 3_600_000;
/** Mints a token and completes a signup with it: the account holds the token's groups, as Polaris ID gives them. */
const made = async (secret: string, subject: string, email: string) => {
  await post(r, '/setup', challenge(secret));
  const id = [...r.idp.signups.keys()].at(-1) as string;
  r.idp.completeSignup(id, subject, { email, emailVerified: true });
  for (const target of r.idp.signups.get(id)?.targets ?? [])
    r.idp.accounts.get(subject)?.roles.add(target);
  return id;
};
const holds = (subject: string) => r.idp.accounts.get(subject)?.roles.has('console') === true;

describe('a forwarded invitation link enrols nobody else', () => {
  it('an accept takes the groups back from another account made from the same invitation, and withdraws the unused tokens', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const p = await person(r, 'agent@agency.test');
    // A stranger signs up from the forwarded link; the real invitee then makes a token of their own.
    await made(invite.secret, 'sub-stranger', 'stranger@evil.test');
    await made(invite.secret, p.subject, invite.email);
    await post(r, '/setup', challenge(invite.secret));
    const unused = [...r.idp.signups.keys()].at(-1) as string;
    expect(holds('sub-stranger')).toBe(true);
    expect((await post(r, '/accept', { token: invite.secret }, p.session.headers)).status).toBe(
      200,
    );
    expect(r.idp.signups.has(unused)).toBe(false);
    await drain();
    expect(holds('sub-stranger')).toBe(false);
    expect(holds(p.subject)).toBe(true);
  });

  it('keeps sweeping an accepted invitation until its last token expired, so a token used later is found', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    const stranger = await made(invite.secret, 'sub-late', invite.email);
    // Accepted (by someone with no proof of that account); nothing marked the stranger.
    await run(r.h.env.DB, 'UPDATE org_invitations SET accepted_at = ? WHERE id = ?', [
      r.h.clock.now(),
      invite.id,
    ]);
    expect(r.idp.signups.has(stranger)).toBe(true);
    await drain();
    expect(holds('sub-late')).toBe(true);
    r.h.clock.advance(HOUR + 300_000);
    await drain();
    await drain();
    expect(holds('sub-late')).toBe(false);
  });

  it('an account made with another address loses its groups once its token expired, not days later', async () => {
    const invite = await memberInvite(r, 'agent@agency.test');
    await made(invite.secret, 'sub-forwarded', 'stranger@evil.test');
    await made(invite.secret, 'sub-invitee', invite.email);
    r.h.clock.advance(HOUR + 300_000);
    await drain();
    await drain();
    expect(holds('sub-forwarded')).toBe(false);
    // The invitee's own account could still accept: it waits for the end of the window.
    expect(holds('sub-invitee')).toBe(true);
    r.h.clock.advance(8 * DAY);
    await drain();
    await drain();
    expect(holds('sub-invitee')).toBe(false);
  });

  it('settles invitations that tie on their end time one by one: the cursor holds the key too', async () => {
    const a = await memberInvite(r, 'one@agency.test');
    const b = await memberInvite(r, 'two@agency.test');
    await made(a.secret, 'sub-a', a.email);
    await made(b.secret, 'sub-b', b.email);
    r.h.clock.advance(9 * DAY);
    const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    const ended = ((await first_row(first?.id as string)).expires_at as number) + DAY;
    // A run that stopped after the first of the two: the next starts after it, at the same instant.
    await run(
      r.h.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES ('system', 'idp.invite_sweep', ?, 1)",
      [JSON.stringify({ at: ended, key: `member:${first?.id}` })],
    );
    await drain();
    expect(holds(second === a ? 'sub-a' : 'sub-b')).toBe(false);
    expect(holds(first === a ? 'sub-a' : 'sub-b')).toBe(true);
  });
});

const first_row = async (id: string) =>
  (await rowsOf(r, 'SELECT expires_at FROM org_invitations WHERE id = ?', [id]))[0] as {
    expires_at: number;
  };
