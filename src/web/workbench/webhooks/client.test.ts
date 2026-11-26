import { describe, expect, it, vi } from 'vitest';
import { connect } from './client.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(handlers: Record<string, (n: number) => Response>) {
  const calls: Call[] = [];
  const seen: Record<string, number> = {};
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.split('?')[0]}`;
    seen[key] = (seen[key] ?? 0) + 1;
    calls.push({
      url,
      method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(seen[key] ?? 0);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const session = { authenticated: true, csrfToken: 'csrf-1' };
const open = () => json({ sandbox: { id: 's1', closedAt: null } });
const token = (n: number) => json({ token: `pbtry_${n}`, expiresAt: 10 * 60_000 }, 201);

describe('connect', () => {
  it('says signed out, without asking for a token', async () => {
    const { fetchFn, calls } = stub({
      'GET /api/v1/session': () => json({ authenticated: false }),
    });
    expect(await connect(fetchFn)).toEqual({ kind: 'signed-out' });
    expect(calls).toHaveLength(1);
  });

  it('says no sandbox without asking for a token', async () => {
    const { fetchFn, calls } = stub({
      'GET /api/v1/session': () => json(session),
      'GET /api/v1/developer/sandbox': () => json({ sandbox: null }),
    });
    expect(await connect(fetchFn)).toEqual({ kind: 'no-sandbox' });
    expect(calls.some((c) => c.url.endsWith('/try-token'))).toBe(false);
  });

  it('says no sandbox on a 404 for the token', async () => {
    const { fetchFn } = stub({
      'GET /api/v1/session': () => json(session),
      'GET /api/v1/developer/sandbox': open,
      'POST /api/v1/developer/try-token': () => json({ code: 'SANDBOX_NOT_FOUND' }, 404),
    });
    expect(await connect(fetchFn)).toEqual({ kind: 'no-sandbox' });
  });

  it('mints with the CSRF token, then calls the API with the try token only', async () => {
    const { fetchFn, calls } = stub({
      'GET /api/v1/session': () => json(session),
      'GET /api/v1/developer/sandbox': open,
      'POST /api/v1/developer/try-token': token,
      'GET /api/v1/webhook-endpoints': () => json({ items: [] }),
      'POST /api/v1/webhook-endpoints/e1/test': () =>
        json({ ok: true, status: 200, durationMs: 1, errorCode: null, captureId: 'c1' }),
    });
    const auth = await connect(fetchFn, () => 0);
    if (auth.kind !== 'ready') throw new Error('expected ready');
    expect(calls.find((c) => c.url.endsWith('/try-token'))?.headers['x-csrf-token']).toBe('csrf-1');
    await auth.api.endpoints();
    expect(await auth.api.sendTest('e1', 'pass.updated')).toMatchObject({ captureId: 'c1' });
    const api = calls.filter((c) => c.url.includes('/webhook-endpoints'));
    expect(api.map((c) => c.headers.authorization)).toEqual(['Bearer pbtry_1', 'Bearer pbtry_1']);
    expect(api[1]?.body).toEqual({ type: 'pass.updated' });
    expect(calls.some((c) => c.headers.authorization?.includes('pb_'))).toBe(false);
  });

  it('takes a new token once on a 401, and reports a second one', async () => {
    const { fetchFn } = stub({
      'GET /api/v1/session': () => json(session),
      'GET /api/v1/developer/sandbox': open,
      'POST /api/v1/developer/try-token': token,
      'GET /api/v1/webhook-endpoints': (n) =>
        n === 1 ? json({ code: 'UNAUTHENTICATED' }, 401) : json({ items: [] }),
    });
    const auth = await connect(fetchFn, () => 0);
    if (auth.kind !== 'ready') throw new Error('expected ready');
    expect(await auth.api.endpoints()).toEqual([]);
    const refused = stub({
      'GET /api/v1/session': () => json(session),
      'GET /api/v1/developer/sandbox': open,
      'POST /api/v1/developer/try-token': token,
      'GET /api/v1/webhook-endpoints': () =>
        json({ code: 'UNAUTHENTICATED', detail: 'Sign in.' }, 401),
    });
    const second = await connect(refused.fetchFn, () => 0);
    if (second.kind !== 'ready') throw new Error('expected ready');
    await expect(second.api.endpoints()).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('mints again before the token runs out', async () => {
    let now = 0;
    const { fetchFn, calls } = stub({
      'GET /api/v1/session': () => json(session),
      'GET /api/v1/developer/sandbox': open,
      'POST /api/v1/developer/try-token': token,
      'GET /api/v1/webhook-endpoints': () => json({ items: [] }),
    });
    const auth = await connect(fetchFn, () => now);
    if (auth.kind !== 'ready') throw new Error('expected ready');
    now = 9.5 * 60_000;
    await auth.api.endpoints();
    expect(calls.filter((c) => c.url.endsWith('try-token'))).toHaveLength(2);
  });

  it('narrows captures and deliveries by request and pass, and leaves out what is not set', async () => {
    const { fetchFn, calls } = stub({
      'GET /api/v1/session': () => json(session),
      'GET /api/v1/developer/sandbox': open,
      'POST /api/v1/developer/try-token': (n) => token(n),
      'GET /api/v1/webhook-endpoints/ep1/captures': () => json({ items: [] }),
      'GET /api/v1/webhook-endpoints/ep1/deliveries': () => json({ items: [] }),
    });
    const auth = await connect(fetchFn, () => 0);
    if (auth.kind !== 'ready') throw new Error('not ready');
    await auth.api.captures('ep1', { type: 'pass.issued', requestId: 'r 1', passId: 'p1' });
    await auth.api.captures('ep1');
    await auth.api.deliveries('ep1', { requestId: 'r1', type: 'pass.issued' });
    const urls = calls.filter((c) => c.url.includes('/ep1/')).map((c) => c.url);
    expect(urls).toEqual([
      '/api/v1/webhook-endpoints/ep1/captures?limit=50&type=pass.issued&requestId=r+1&passId=p1',
      '/api/v1/webhook-endpoints/ep1/captures?limit=50',
      '/api/v1/webhook-endpoints/ep1/deliveries?limit=30&requestId=r1',
    ]);
  });
});
