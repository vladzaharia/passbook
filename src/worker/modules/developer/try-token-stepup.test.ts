import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { signTryToken, TRY_TOKEN_TTL_MS } from './try-token.ts';
import { fromPage, ORIGIN, tryKit } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof tryKit>>;
beforeAll(async () => {
  t = await tryKit();
});
afterAll(() => vi.unstubAllGlobals());

/** A developer whose try token is live; the session proved its sign-in just now. */
async function person() {
  const d = await t.developer();
  const { token } = await t.mint(d.browser);
  const headers = { ...fromPage(d.browser, token), 'content-type': 'application/json' };
  return (method: string, path: string, body?: unknown) =>
    t.app.request(
      `${ORIGIN}/api/v1${path}`,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      t.kit.env,
    );
}

const HOOK = { url: 'https://example.com/hook', eventTypes: ['pass.issued'] };
/** Past the 600 s step-up window, inside the token's 15 minutes and the session's idle time. */
const STALE_MS = 700_000;

describe('a try token stands for its session: step-up applies', () => {
  it('allows the sensitive webhook calls on a fresh sign-in and refuses them on a stale one', async () => {
    const call = await person();
    const created = await call('POST', '/webhook-endpoints', HOOK);
    expect(created.status, await created.clone().text()).toBe(201);
    const id = ((await created.json()) as { endpoint: { id: string } }).endpoint.id;
    const list = (await (await call('GET', '/webhook-endpoints')).json()) as {
      items: { id: string; target: string }[];
    };
    const captureId = list.items.find((e) => e.target === 'capture')?.id ?? '';
    expect(captureId).not.toBe('');
    const status = async (...args: Parameters<typeof call>) => (await call(...args)).status;
    expect(await status('POST', `/webhook-endpoints/${id}/secret`, { overlapHours: 24 })).toBe(200);
    expect(await status('POST', `/webhook-endpoints/${captureId}/captures/secret`)).toBe(200);
    expect(
      await status('PATCH', `/webhook-endpoints/${id}`, { url: 'https://example.com/b' }),
    ).toBe(200);

    t.kit.clock.advance(STALE_MS);
    for (const [method, path, body] of [
      ['POST', '/webhook-endpoints', HOOK],
      ['POST', `/webhook-endpoints/${id}/secret`, { overlapHours: 24 }],
      ['POST', `/webhook-endpoints/${captureId}/captures/secret`, undefined],
      ['PATCH', `/webhook-endpoints/${id}`, { url: 'https://example.com/other' }],
      ['PATCH', `/webhook-endpoints/${id}`, { eventTypes: ['pass.updated'] }],
    ] as const)
      await expectProblem(await call(method, path, body), 403, 'STEP_UP_REQUIRED');

    // Reads and non-sensitive changes stay open.
    expect(await status('GET', '/webhook-endpoints')).toBe(200);
    expect(await status('PATCH', `/webhook-endpoints/${id}`, { description: 'x' })).toBe(200);
  });

  it('sends a break-glass session to break-glass, not Polaris ID', async () => {
    const d = await t.developer();
    const bg = await makeSession(t.kit.f, {
      userId: d.user.id,
      roles: ['user', 'developer'],
      amr: 'breakglass',
      authTime: t.kit.clock.now() - STALE_MS,
    });
    const cookie = bg.headers.cookie ?? '';
    const row = await first<{ try_generation: number }>(
      t.kit.env.DB,
      'SELECT try_generation FROM developer_sandboxes WHERE user_id = ?',
      [d.user.id],
    );
    const token = await signTryToken(t.kit.env, {
      keyId: d.key.id,
      sessionIdHash: await sha256Hex(cookie.split('=').slice(1).join('=')),
      generation: row?.try_generation ?? 0,
      expiresAt: t.kit.clock.now() + TRY_TOKEN_TTL_MS,
    });
    const res = await t.app.request(
      `${ORIGIN}/api/v1/webhook-endpoints`,
      {
        method: 'POST',
        headers: {
          ...fromPage({ ...bg.headers, ...d.browser, cookie }, token),
          'content-type': 'application/json',
        },
        body: JSON.stringify(HOOK),
      },
      t.kit.env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; signInUrl?: string };
    expect(body.code).toBe('STEP_UP_REQUIRED');
    expect(body.signInUrl).toContain('/auth/breakglass');
  });
});
