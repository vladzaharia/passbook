import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import {
  fakeLimiter,
  harness,
  type SentMail,
  type TestHarness,
  waitingPass,
} from '../auth/test-support.ts';
import { attachWaitingPassesForEmail } from '../holders/service.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

type Entry = { email: string; primary: boolean; verifiedAt: number | null };
const tokenOf = (m: SentMail | undefined) => /t=([\w-]+)/.exec(m?.text ?? '')?.[1] ?? '';

/** A user whose profile email was never proven: no user_emails row. */
async function unverifiedUser() {
  const user = await makeUser(f());
  await run(h.env.DB, 'DELETE FROM user_emails WHERE user_id = ?', [user.id]);
  const session = await makeSession(f(), { userId: user.id });
  return { user, session };
}
const list = async (headers: Record<string, string>) =>
  ((await (await h.call('/api/v1/me/emails', { headers })).json()) as { items: Entry[] }).items;
const verify = (headers: Record<string, string>, email: string) =>
  h.call('/api/v1/me/emails', { method: 'POST', headers, json: { email } });
const consume = (headers: Record<string, string>, token: string) =>
  h.call('/auth/magic/consume', {
    method: 'POST',
    body: new URLSearchParams({ token }),
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
  });
const ownerOf = async (passId: string) =>
  (
    await first<{ owner_user_id: string | null }>(
      h.env.DB,
      'SELECT owner_user_id FROM passes WHERE id = ?',
      [passId],
    )
  )?.owner_user_id;
const giveTo = (userId: string, email: string) =>
  run(
    h.env.DB,
    'INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, ?, 0)',
    [email, userId, 'admin'],
  );

describe('unverified primary email', () => {
  it('is listed as primary and unverified', async () => {
    const { user, session } = await unverifiedUser();
    expect(await list(session.headers)).toEqual([
      { email: user.primaryEmail, primary: true, verifiedAt: null, verifiedVia: null },
    ]);
  });

  it('attaches no passes and is not in the verified set', async () => {
    const { user, session } = await unverifiedUser();
    const pass = await waitingPass(user.primaryEmail);
    await list(session.headers);
    const ctx = createServiceContext(h.env);
    expect(await attachWaitingPassesForEmail(ctx, user.id, user.primaryEmail)).toBe(0);
    expect(await ownerOf(pass.id)).toBeFalsy();
    const rows = await all(h.env.DB, 'SELECT 1 FROM user_emails WHERE email = ?', [
      user.primaryEmail,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('cannot be removed', async () => {
    const { user, session } = await unverifiedUser();
    const res = await h.call(`/api/v1/me/emails/${encodeURIComponent(user.primaryEmail)}`, {
      method: 'DELETE',
      headers: session.headers,
    });
    expect(res.status).toBe(409);
  });

  it('verifies through the mailed link, attaches waiting passes, leaves one row', async () => {
    const { user, session } = await unverifiedUser();
    const pass = await waitingPass(user.primaryEmail);
    expect((await verify(session.headers, user.primaryEmail)).status).toBe(202);
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0]?.to).toBe(user.primaryEmail);
    expect(await ownerOf(pass.id)).toBeFalsy();
    expect((await consume(session.headers, tokenOf(h.mail[0]))).status).toBe(303);
    const items = await list(session.headers);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      email: user.primaryEmail,
      primary: true,
      verifiedVia: 'magic_link',
    });
    expect(items[0]?.verifiedAt).not.toBeNull();
    expect(await ownerOf(pass.id)).toBe(user.id);
  });

  it('refuses a link consumed by another account', async () => {
    const { user, session } = await unverifiedUser();
    await verify(session.headers, user.primaryEmail);
    const other = await makeSession(f(), { userId: (await makeUser(f())).id });
    expect((await consume(other.headers, tokenOf(h.mail[0]))).status).toBe(403);
    expect((await list(session.headers))[0]?.verifiedAt).toBeNull();
  });

  it('sends nothing when another account holds the address as verified', async () => {
    const { user, session } = await unverifiedUser();
    await giveTo((await makeUser(f())).id, user.primaryEmail);
    expect((await verify(session.headers, user.primaryEmail)).status).toBe(202);
    expect(h.mail).toHaveLength(0);
    expect((await list(session.headers))[0]?.verifiedAt).toBeNull();
  });

  it('is refused at consume when another account verified it after the mail went out', async () => {
    const { user, session } = await unverifiedUser();
    await verify(session.headers, user.primaryEmail);
    const other = await makeUser(f());
    await giveTo(other.id, user.primaryEmail);
    expect((await consume(session.headers, tokenOf(h.mail[0]))).status).toBe(403);
    const owners = await all<{ user_id: string }>(
      h.env.DB,
      'SELECT user_id FROM user_emails WHERE email = ?',
      [user.primaryEmail],
    );
    expect(owners).toEqual([{ user_id: other.id }]);
  });

  it('counts against the per-user daily cap and the rate limit', async () => {
    const { user, session } = await unverifiedUser();
    for (let i = 0; i < 10; i++) {
      expect((await verify(session.headers, `cap${i}-${user.id}@example.test`)).status).toBe(202);
    }
    expect((await verify(session.headers, user.primaryEmail)).status).toBe(429);
    h.restore();
    h = await harness({ RL_MAGIC_LINK: fakeLimiter(0) as unknown as RateLimit });
    const again = await unverifiedUser();
    expect((await verify(again.session.headers, again.user.primaryEmail)).status).toBe(429);
  });
});
