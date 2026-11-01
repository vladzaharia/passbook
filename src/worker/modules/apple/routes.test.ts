import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, fakeRateLimiter } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { getPass, type Pass } from '../passes/repo.ts';
import { updatePass } from '../passes/service.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { dailyApple } from './jobs.ts';

const ORIGIN = 'https://wallet.test';
const TYPE = 'pass.im.plrs.wallet';
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fakeAuth(ORIGIN).stores });
});

const call = (path: string, init: RequestInit = {}) =>
  app.request(`${ORIGIN}/wallet/v1${path}`, init, kit.env);
const authHeader = (pass: Pass) => ({ authorization: `ApplePass ${pass.authToken}` });
const token = (c: string) => c.repeat(64);
const register = (
  pass: Pass,
  device: string,
  pushToken = token('a'),
  headers: Record<string, string> = authHeader(pass),
) =>
  call(`/devices/${device}/registrations/${TYPE}/${pass.serial}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ pushToken }),
  });

describe('register', () => {
  it('returns 201 for a new registration and 200 when it repeats, updating the token', async () => {
    const pass = await kit.pass();
    expect((await register(pass, 'dev-1', token('a'))).status).toBe(201);
    expect((await register(pass, 'dev-1', token('b'))).status).toBe(200);
    const device = await first<{ push_token: string }>(
      kit.env.DB,
      'SELECT push_token FROM devices WHERE device_id = ?',
      ['dev-1'],
    );
    expect(device?.push_token).toBe(token('b'));
    const count = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM registrations WHERE pass_id = ?',
      [pass.id],
    );
    expect(count?.n).toBe(1);
  });

  it('answers 401 for a missing, wrong or differently sized token and for unknown passes alike', async () => {
    const pass = await kit.pass();
    const wrong: Record<string, string>[] = [
      {},
      { authorization: 'ApplePass nope' },
      { authorization: `ApplePass ${pass.authToken}x` },
      { authorization: pass.authToken },
    ];
    for (const headers of wrong)
      expect((await register(pass, 'dev-x', token('a'), headers)).status).toBe(401);
    const unknown = await call(`/devices/dev-x/registrations/${TYPE}/no-such-serial`, {
      method: 'POST',
      headers: authHeader(pass),
      body: JSON.stringify({ pushToken: token('a') }),
    });
    expect(unknown.status).toBe(401);
    const otherType = await call(`/devices/dev-x/registrations/pass.other/${pass.serial}`, {
      method: 'POST',
      headers: authHeader(pass),
      body: JSON.stringify({ pushToken: token('a') }),
    });
    expect(otherType.status).toBe(401);
    const stored = await first(kit.env.DB, 'SELECT 1 FROM devices WHERE device_id = ?', ['dev-x']);
    expect(stored).toBeNull();
  });

  it('rejects malformed push tokens and device ids', async () => {
    const pass = await kit.pass();
    for (const bad of ['', 'xyz', 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(129)])
      expect((await register(pass, 'dev-bad', bad)).status).toBe(400);
    expect((await register(pass, 'dev bad', token('a'))).status).toBe(400);
    const noBody = await call(`/devices/dev-bad/registrations/${TYPE}/${pass.serial}`, {
      method: 'POST',
      headers: authHeader(pass),
    });
    expect(noBody.status).toBe(400);
  });

  it('caps registrations at 20 per pass but still updates an existing device at the cap', async () => {
    const pass = await kit.pass();
    for (let i = 0; i < 20; i++) expect((await register(pass, `cap-${i}`)).status).toBe(201);
    const over = await register(pass, 'cap-20');
    expect(over.status).toBe(429);
    expect(((await over.json()) as { code: string }).code).toBe('REGISTRATION_LIMIT');
    expect((await register(pass, 'cap-3', token('c'))).status).toBe(200);
    const count = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM registrations WHERE pass_id = ?',
      [pass.id],
    );
    expect(count?.n).toBe(20);
    const orphan = await first(kit.env.DB, "SELECT 1 FROM devices WHERE device_id = 'cap-20'");
    expect(orphan).toBeNull();
  });
});

describe('unregister', () => {
  it('removes the registration and the device when it was the last', async () => {
    const pass = await kit.pass();
    await register(pass, 'dev-un');
    const res = await call(`/devices/dev-un/registrations/${TYPE}/${pass.serial}`, {
      method: 'DELETE',
      headers: authHeader(pass),
    });
    expect(res.status).toBe(200);
    expect(await first(kit.env.DB, "SELECT 1 FROM devices WHERE device_id = 'dev-un'")).toBeNull();
  });

  it('keeps the device while it has other passes, and needs the token', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    await register(a, 'dev-two');
    await register(b, 'dev-two');
    const denied = await call(`/devices/dev-two/registrations/${TYPE}/${a.serial}`, {
      method: 'DELETE',
    });
    expect(denied.status).toBe(401);
    await call(`/devices/dev-two/registrations/${TYPE}/${a.serial}`, {
      method: 'DELETE',
      headers: authHeader(a),
    });
    expect(
      await first(kit.env.DB, "SELECT 1 FROM devices WHERE device_id = 'dev-two'"),
    ).not.toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ?', [a.id]),
    ).toBeNull();
  });
});

describe('serials since a tag', () => {
  it('lists changed serials with a tag that advances, then 204', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    await register(a, 'dev-ser');
    await register(b, 'dev-ser');
    const first1 = await call(`/devices/dev-ser/registrations/${TYPE}`);
    expect(first1.status).toBe(200);
    const body = (await first1.json()) as { serialNumbers: string[]; lastUpdated: string };
    expect(body.serialNumbers.sort()).toEqual([a.serial, b.serial].sort());
    expect(Number(body.lastUpdated)).toBe(Math.max(a.revision, b.revision));

    const none = await call(
      `/devices/dev-ser/registrations/${TYPE}?passesUpdatedSince=${body.lastUpdated}`,
    );
    expect(none.status).toBe(204);

    await updatePass(
      kit.ctx,
      { type: 'system', id: null },
      a.id,
      { input: { memberName: 'Changed' } },
      { scope: null },
    );
    const changed = await call(
      `/devices/dev-ser/registrations/${TYPE}?passesUpdatedSince=${body.lastUpdated}`,
    );
    const next = (await changed.json()) as { serialNumbers: string[]; lastUpdated: string };
    expect(next.serialNumbers).toEqual([a.serial]);
    expect(Number(next.lastUpdated)).toBeGreaterThan(Number(body.lastUpdated));
  });

  it('is empty for unknown devices and pass types, and rejects a bad tag', async () => {
    expect((await call(`/devices/nobody/registrations/${TYPE}`)).status).toBe(204);
    expect((await call(`/devices/nobody/registrations/pass.unknown`)).status).toBe(204);
    expect(
      (await call(`/devices/nobody/registrations/${TYPE}?passesUpdatedSince=abc`)).status,
    ).toBe(400);
  });

  it('never lists another device’s passes', async () => {
    const pass = await kit.pass();
    await register(pass, 'dev-owner');
    expect((await call(`/devices/dev-other/registrations/${TYPE}`)).status).toBe(204);
  });
});

describe('latest pass', () => {
  const get = (pass: Pass, headers: Record<string, string> = {}) =>
    call(`/passes/${TYPE}/${pass.serial}`, { headers: { ...authHeader(pass), ...headers } });

  it('requires the token', async () => {
    const pass = await kit.pass();
    expect((await call(`/passes/${TYPE}/${pass.serial}`)).status).toBe(401);
    expect(
      (await call(`/passes/${TYPE}/${pass.serial}`, { headers: { authorization: 'ApplePass x' } }))
        .status,
    ).toBe(401);
  });

  it('serves the signed pass with validators', async () => {
    const pass = await kit.pass();
    const res = await get(pass);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.pkpass');
    expect(res.headers.get('etag')).toBe(`"${pass.objectSha256}"`);
    expect(res.headers.get('last-modified')).toBe(
      new Date(Math.floor(pass.modifiedAt / 1000) * 1000).toUTCString(),
    );
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it('answers 304 for If-Modified-Since and If-None-Match, and 200 once the pass changed', async () => {
    const pass = await kit.pass();
    const first1 = await get(pass);
    const lastModified = first1.headers.get('last-modified') ?? '';
    await first1.arrayBuffer();
    expect((await get(pass, { 'if-modified-since': lastModified })).status).toBe(304);
    expect((await get(pass, { 'if-none-match': `"${pass.objectSha256}"` })).status).toBe(304);
    expect((await get(pass, { 'if-none-match': `W/"other", "${pass.objectSha256}"` })).status).toBe(
      304,
    );
    expect(
      (await get(pass, { 'if-none-match': '"other"', 'if-modified-since': lastModified })).status,
    ).toBe(200);

    kit.clock.advance(5000);
    await run(kit.env.DB, 'UPDATE passes SET modified_at = modified_at WHERE id = ?', [pass.id]);
    await updatePass(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'Newer' } },
      { scope: null },
    );
    const updated = await getPass(kit.env.DB, pass.id);
    const after = await get(pass, { 'if-modified-since': lastModified });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).toBe(`"${updated?.objectSha256}"`);
    await after.arrayBuffer();
  });

  it('never hides an update made in the same second as the last one', async () => {
    const pass = await kit.pass();
    await updatePass(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'Quick' } },
      { scope: null },
    );
    const row = await getPass(kit.env.DB, pass.id);
    expect(row?.modifiedCollision).toBe(true);
    const res = await get(pass, {
      'if-modified-since': new Date(row?.modifiedAt ?? 0).toUTCString(),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });
});

describe('log', () => {
  const post = (logs: unknown, size?: number) =>
    call('/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logs, pad: size ? 'x'.repeat(size) : undefined }),
    });

  it('stores redacted lines and caps a request at 100 lines', async () => {
    await run(kit.env.DB, 'DELETE FROM wallet_logs');
    const lines = Array.from(
      { length: 150 },
      (_, i) => `line ${i} user@example.com ApplePass abcdef123456 /p/${'t'.repeat(30)}`,
    );
    expect((await post(lines)).status).toBe(200);
    const rows = await all<{ line: string }>(kit.env.DB, 'SELECT line FROM wallet_logs');
    expect(rows).toHaveLength(100);
    const joined = rows.map((r) => r.line).join('\n');
    expect(joined).not.toContain('user@example.com');
    expect(joined).not.toContain('abcdef123456');
    expect(joined).not.toContain('ttttttttttttttttttttttttt');
  });

  it('truncates long lines and strips control characters', async () => {
    await run(kit.env.DB, 'DELETE FROM wallet_logs');
    await post([`a\u0000b${'z'.repeat(5000)}`]);
    const row = await first<{ line: string }>(kit.env.DB, 'SELECT line FROM wallet_logs');
    expect(row?.line.length).toBeLessThanOrEqual(1000);
    expect(row?.line.startsWith('a b')).toBe(true);
  });

  it('rejects oversized bodies and invalid payloads', async () => {
    expect((await post(['x'], 100_000)).status).toBe(413);
    expect((await post('not an array')).status).toBe(422);
  });

  it('stops storing once the hourly budget is spent', async () => {
    await run(kit.env.DB, 'DELETE FROM wallet_logs');
    const hour = 3_600_000;
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO counters (key, window_start, count) VALUES ('apple.log', ?, 4990)",
      [Math.floor(Date.now() / hour) * hour],
    );
    const res = await post(Array.from({ length: 20 }, (_, i) => `l${i}`));
    expect(res.status).toBe(429);
    expect(await first(kit.env.DB, 'SELECT 1 FROM wallet_logs')).toBeNull();
  });
});

describe('retention', () => {
  it('drops device logs and revision markers older than 7 days', async () => {
    const day = 86_400_000;
    const now = kit.clock.now();
    await run(kit.env.DB, 'DELETE FROM wallet_logs');
    await run(kit.env.DB, 'INSERT INTO wallet_logs (at, line) VALUES (?, ?), (?, ?)', [
      now - 8 * day,
      'old',
      now - day,
      'new',
    ]);
    await run(kit.env.DB, "INSERT INTO revisions (pass_id, at) VALUES ('p-old', ?)", [
      now - 8 * day,
    ]);
    await dailyApple(kit.ctx);
    const lines = await all<{ line: string }>(kit.env.DB, 'SELECT line FROM wallet_logs');
    expect(lines.map((l) => l.line)).toEqual(['new']);
    expect(await first(kit.env.DB, "SELECT 1 FROM revisions WHERE pass_id = 'p-old'")).toBeNull();
    // The high-water mark survives pruning so tags never repeat.
    const seq = await first<{ seq: number }>(
      kit.env.DB,
      "SELECT seq FROM sqlite_sequence WHERE name = 'revisions'",
    );
    expect(seq?.seq ?? 0).toBeGreaterThan(0);
  });
});

describe('rate limit layers', () => {
  const limited = (ip: number, device: number) => ({
    ip: fakeRateLimiter({ limit: ip }),
    device: fakeRateLimiter({ limit: device }),
  });
  const send = (path: string, env: AppEnv, ipAddr = '198.51.100.7') =>
    app.request(`${ORIGIN}/wallet/v1${path}`, { headers: { 'cf-connecting-ip': ipAddr } }, env);
  const envWith = (l: ReturnType<typeof limited>) =>
    ({ ...kit.env, RL_APPLE_IP: l.ip, RL_APPLE: l.device }) as AppEnv;

  it('does not throttle many devices behind one IP', async () => {
    const env = envWith(limited(3000, 120));
    for (let i = 0; i < 400; i++)
      expect((await send(`/devices/nat-${i}/registrations/${TYPE}`, env)).status).not.toBe(429);
  });

  it('limits one serial to 120 requests per window', async () => {
    const env = envWith(limited(3000, 120));
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++)
      statuses.push((await send(`/passes/${TYPE}/one-serial`, env, `10.0.${i % 200}.1`)).status);
    expect(statuses.slice(0, 120)).not.toContain(429);
    expect(statuses[120]).toBe(429);
  });

  it('limits one IP to 3000 requests per window', async () => {
    const l = limited(3000, 120);
    l.ip.counts.set('RL_APPLE_IP:203.0.113.9', 3000);
    expect((await send(`/devices/x/registrations/${TYPE}`, envWith(l), '203.0.113.9')).status).toBe(
      429,
    );
    expect(
      (await send(`/devices/x/registrations/${TYPE}`, envWith(l), '203.0.113.10')).status,
    ).not.toBe(429);
  });
});
