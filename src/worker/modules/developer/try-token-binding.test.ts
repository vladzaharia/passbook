import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { signTryToken, TRY_TOKEN_TTL_MS, verifyTryToken } from './try-token.ts';
import { bearer, fromPage, ORIGIN, page, tryKit } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof tryKit>>;
beforeAll(async () => {
  t = await tryKit();
});
afterAll(() => vi.unstubAllGlobals());
const send = (...args: Parameters<typeof t.send>) => t.send(...args);
const developer = () => t.developer();
const mint = (browser: Record<string, string>) => t.mint(browser);

describe('try token binding', () => {
  it('works only beside the session cookie it was made for, and sends no CORS headers', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const ok = await send('GET', '/passes', fromPage(d.browser, token));
    expect(ok.status).toBe(200);
    expect([...ok.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);
    // Copied off the page: no cookie, or another session of the same person.
    await expectProblem(await send('GET', '/passes', bearer(token)), 401, 'INVALID_API_KEY');
    const phone = await makeSession(t.kit.f, { userId: d.user.id, roles: ['user', 'developer'] });
    await expectProblem(
      await send('GET', '/passes', { cookie: phone.headers.cookie ?? '', ...bearer(token) }),
      401,
      'INVALID_API_KEY',
    );
  });

  it('never falls back to the session when the token is dead beside a live cookie', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    expect((await send('DELETE', '/developer/try-token', d.browser)).status).toBe(200);
    await expectProblem(
      await send('GET', '/passes', fromPage(d.browser, token)),
      401,
      'INVALID_API_KEY',
    );
  });

  it('stops when the membership is removed or the user disabled', async () => {
    const member = await developer();
    const a = await mint(member.browser);
    await run(t.kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE org_id = ?', [
      t.kit.clock.now(),
      member.made.orgId,
    ]);
    expect((await send('GET', '/passes', page(member, a.token))).status).toBe(401);
    const user = await developer();
    const b = await mint(user.browser);
    await run(t.kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.user.id]);
    expect((await send('GET', '/passes', page(user, b.token))).status).toBe(401);
  });

  it('marks the audit rows of its writes with via: try', async () => {
    const d = await developer();
    const { token } = await mint(d.browser);
    const res = await t.app.request(
      `${ORIGIN}/api/v1/webhook-endpoints`,
      {
        method: 'POST',
        headers: { ...fromPage(d.browser, token), 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/hook', eventTypes: ['pass.issued'] }),
      },
      t.kit.env,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const row = await first<{ detail: string | null }>(
      t.kit.env.DB,
      'SELECT detail FROM audit_log WHERE org_id = ? AND actor_type = ? ORDER BY id DESC LIMIT 1',
      [d.made.orgId, 'api_key'],
    );
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({ via: 'try' });
  });

  it('verifies under the previous MAC root during a rotation, and not after', async () => {
    const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
    const base = { ...t.kit.env, KEK_V1: kek(1), KEK_V2: kek(2) };
    const claims = {
      keyId: 'k',
      sessionIdHash: 'a'.repeat(64),
      generation: 1,
      expiresAt: t.kit.clock.now() + TRY_TOKEN_TTL_MS,
    };
    const token = await signTryToken(base, claims);
    const rotating = { ...base, MAC_KEY_VERSION: '2', MAC_KEY_VERSION_PREVIOUS: '1' };
    expect(await verifyTryToken(rotating, token)).toEqual(claims);
    expect(await verifyTryToken({ ...base, MAC_KEY_VERSION: '2' }, token)).toBeNull();
  });
});
