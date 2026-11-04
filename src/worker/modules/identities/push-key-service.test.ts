import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeAuth, makeEnv } from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createLogger, type LogData } from '../../platform/log.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { apnsMethod, createApnsTransport } from '../delivery/apns.ts';
import { clearApnsTokens } from '../delivery/apns-jwt.ts';
import { classifyApns } from '../delivery/push.ts';
import { identityComponent } from '../status/checks.ts';
import { probeApns } from './apns-probe.ts';
import { makeP8 } from './push-key-fixtures.ts';
import { clearPushKeyCache, loadPushKey } from './push-key-store.ts';
import { getIdentityRow } from './repo.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const fake = fakeAuth();
const KEY_ID = 'AB12CD34EF';

let env: AppEnv;
let app: ReturnType<typeof createApp>;
let a: string;
let b: string;

const json = { 'content-type': 'application/json' };
const request = (path: string, init: RequestInit & { as?: Record<string, string> } = {}, e = env) =>
  app.request(
    path,
    { ...init, headers: { ...(init.as ?? fake.admin()), ...json, ...init.headers } },
    e,
  );
const putKey = (id: string, body: unknown, as?: Record<string, string>) =>
  request(`/api/v1/identities/${id}/push-key`, {
    method: 'PUT',
    body: JSON.stringify(body),
    ...(as ? { as } : {}),
  });
const get = async (id: string) =>
  (await (await request(`/api/v1/identities/${id}`)).json()) as {
    pushMethod: string;
    apnsAvailable: boolean;
    pushKey: { keyId: string; identityCount: number; rotatedAt: number | null } | null;
  };

async function create(label: string, passType: string, team: string): Promise<string> {
  const f = await createFixtureIdentity({ passTypeIdentifier: passType, teamIdentifier: team });
  env.SIGNER_PLATFORM_INTERMEDIATE = f.intermediate;
  const res = await request('/api/v1/identities', {
    method: 'POST',
    body: JSON.stringify({ label, certificatePem: f.certificate, privateKeyPem: f.privateKey }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  env = await makeEnv({ KEK_V1 });
  app = createApp({ stores: fake.stores });
  a = await create('A', 'pass.com.pk.a', 'TEAMAAAAAA');
  b = await create('B', 'pass.com.pk.b', 'TEAMBBBBBB');
});

afterEach(() => {
  vi.restoreAllMocks();
  clearApnsTokens();
});

function stubFetch(reply: () => Response | Promise<Response>) {
  const seen: { url: string; headers: Headers }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return reply();
  });
  return seen;
}

describe('push key routes', () => {
  it('is none until a key is set, then serves the whole team', async () => {
    expect(await get(a)).toMatchObject({ pushMethod: 'none', apnsAvailable: false, pushKey: null });
    const { pem } = await makeP8();
    const res = await putKey(a, { keyId: KEY_ID, p8: pem });
    expect(res.status).toBe(200);
    expect(await get(a)).toMatchObject({
      pushMethod: 'key',
      apnsAvailable: true,
      pushKey: { keyId: KEY_ID, identityCount: 1, rotatedAt: null },
    });
    // Another team has no key.
    expect(await get(b)).toMatchObject({ pushMethod: 'none', pushKey: null });
  });

  it('stores the key encrypted, never in audit or responses', async () => {
    const row = await first<{ ciphertext: ArrayBuffer }>(
      env.DB,
      "SELECT ciphertext FROM apns_keys WHERE team_identifier = 'TEAMAAAAAA'",
    );
    expect(new TextDecoder().decode(new Uint8Array(row?.ciphertext ?? []))).not.toContain(
      'PRIVATE',
    );
    const audit = await all<{ action: string; detail: string }>(
      env.DB,
      "SELECT action, detail FROM audit_log WHERE action LIKE 'identity.push_key%' AND target_id = ?",
      [a],
    );
    expect(audit.map((r) => r.action)).toEqual(['identity.push_key_set']);
    expect(audit[0]?.detail).toContain(KEY_ID);
    expect(audit[0]?.detail).not.toMatch(/PRIVATE|BEGIN/);
  });

  it('rejects bad keys and key IDs with stable codes', async () => {
    const bad = await putKey(a, { keyId: KEY_ID, p8: 'nope' });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'PUSH_KEY_FORMAT' });
    const curve = await putKey(a, { keyId: KEY_ID, p8: (await makeP8('P-384')).pem });
    expect(await curve.json()).toMatchObject({ code: 'PUSH_KEY_CURVE' });
    const id = await putKey(a, { keyId: 'short', p8: (await makeP8()).pem });
    expect(await id.json()).toMatchObject({ code: 'PUSH_KEY_ID' });
    expect((await get(a)).pushKey?.keyId).toBe(KEY_ID);
  });

  it('requires an admin, a CSRF header and a known identity', async () => {
    const body = { keyId: KEY_ID, p8: (await makeP8()).pem };
    expect((await putKey(a, body, fake.user())).status).toBe(403);
    expect((await putKey(a, body, { cookie: fake.admin().cookie ?? '' })).status).toBe(403);
    expect((await putKey('nope', body)).status).toBe(404);
    expect((await request('/api/v1/identities/nope/push-key', { method: 'DELETE' })).status).toBe(
      404,
    );
  });

  it('replaces the key in place and audits a rotation', async () => {
    clearPushKeyCache();
    const before = await loadPushKey(env, 'TEAMAAAAAA');
    await putKey(a, { keyId: 'ZZ99YY88XX', p8: (await makeP8()).pem });
    const after = await get(a);
    expect(after.pushKey).toMatchObject({ keyId: 'ZZ99YY88XX' });
    expect(after.pushKey?.rotatedAt).toEqual(expect.any(Number));
    expect((await loadPushKey(env, 'TEAMAAAAAA'))?.keyId).toBe('ZZ99YY88XX');
    expect(before?.keyId).toBe(KEY_ID);
    const n = await first<{ n: number }>(env.DB, 'SELECT count(*) AS n FROM apns_keys');
    expect(n?.n).toBe(1);
    expect(
      await first(env.DB, "SELECT 1 FROM audit_log WHERE action = 'identity.push_key_rotate'"),
    ).not.toBeNull();
  });

  it('refuses a row whose team was swapped (AAD binds id and team)', async () => {
    await run(env.DB, "UPDATE apns_keys SET team_identifier = 'TEAMBBBBBB'");
    clearPushKeyCache();
    await expect(loadPushKey(env, 'TEAMBBBBBB')).rejects.toMatchObject({
      code: 'PUSH_KEY_UNREADABLE',
    });
    await run(env.DB, "UPDATE apns_keys SET team_identifier = 'TEAMAAAAAA'");
    clearPushKeyCache();
    expect(await loadPushKey(env, 'TEAMAAAAAA')).not.toBeNull();
  });

  it('removes the key and audits it', async () => {
    const res = await request(`/api/v1/identities/${a}/push-key`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await get(a)).toMatchObject({ pushMethod: 'none', pushKey: null });
    const again = await request(`/api/v1/identities/${a}/push-key`, { method: 'DELETE' });
    expect(again.status).toBe(409);
    expect(
      await first(env.DB, "SELECT 1 FROM audit_log WHERE action = 'identity.push_key_remove'"),
    ).not.toBeNull();
  });
});

describe('transport choice and probe', () => {
  const target = (team: string) => ({
    passTypeIdentifier: 'pass.com.pk.a',
    apnsBinding: null,
    teamIdentifier: team,
  });

  beforeAll(async () => {
    expect((await putKey(a, { keyId: KEY_ID, p8: (await makeP8()).pem })).status).toBe(200);
  });

  it('prefers the mTLS binding, then the team key, else unavailable', async () => {
    const bound = {
      ...env,
      APNS_PK: { fetch: async () => new Response('{}') },
    } as unknown as AppEnv;
    expect(await apnsMethod(bound, { ...target('TEAMAAAAAA'), apnsBinding: 'APNS_PK' })).toBe(
      'certificate',
    );
    expect(await apnsMethod(env, { ...target('TEAMAAAAAA'), apnsBinding: 'APNS_PK' })).toBe('key');
    expect(await apnsMethod(env, target('TEAMBBBBBB'))).toBe('none');
    expect(await apnsMethod(env, { ...target(''), apnsBinding: null })).toBe('none');
    const transport = createApnsTransport(env);
    expect(await transport.isAvailable(target('TEAMAAAAAA'))).toBe(true);
    expect(await transport.isAvailable(target('TEAMBBBBBB'))).toBe(false);
  });

  it('sends with a bearer token and the pass type as topic; the binding wins when present', async () => {
    const seen = stubFetch(() => new Response('{}', { status: 200, headers: { 'apns-id': 'x1' } }));
    const [ok] = await createApnsTransport(env).send(
      target('TEAMAAAAAA'),
      ['t1'],
      1_700_000_000_000,
    );
    expect(ok).toEqual({ token: 't1', status: 200, apnsId: 'x1' });
    expect(seen[0]?.url).toBe('https://api.push.apple.com/3/device/t1');
    expect(seen[0]?.headers.get('authorization')).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(seen[0]?.headers.get('apns-topic')).toBe('pass.com.pk.a');

    seen.length = 0;
    let viaBinding = 0;
    const bound = {
      ...env,
      APNS_PK: {
        fetch: async () => {
          viaBinding++;
          return new Response('{}');
        },
      },
    } as unknown as AppEnv;
    await createApnsTransport(bound).send(
      { ...target('TEAMAAAAAA'), apnsBinding: 'APNS_PK' },
      ['t2'],
      0,
    );
    expect(viaBinding).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it('reuses the cached token across devices and drops it on ExpiredProviderToken', async () => {
    const auth: string[] = [];
    let reply = () => new Response('{}', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      auth.push(new Headers(init?.headers).get('authorization') ?? '');
      return reply();
    });
    const transport = createApnsTransport(env);
    await transport.send(target('TEAMAAAAAA'), ['t1', 't2'], 1_700_000_000_000);
    await transport.send(target('TEAMAAAAAA'), ['t3'], 1_700_000_000_000 + 60_000);
    expect(new Set(auth).size).toBe(1);
    reply = () => new Response(JSON.stringify({ reason: 'ExpiredProviderToken' }), { status: 403 });
    const [expired] = await transport.send(
      target('TEAMAAAAAA'),
      ['t4'],
      1_700_000_000_000 + 120_000,
    );
    expect(classifyApns(expired as never)).toBe('cert');
    reply = () => new Response('{}', { status: 200 });
    await transport.send(target('TEAMAAAAAA'), ['t5'], 1_700_000_000_000 + 180_000);
    expect(auth.at(-1)).not.toBe(auth[0]);
  });

  it.each([
    [410, 'Unregistered', 'gone'],
    [400, 'BadDeviceToken', 'gone'],
    [400, 'DeviceTokenNotForTopic', 'gone'],
    [429, 'TooManyRequests', 'transient'],
    [503, 'ServiceUnavailable', 'transient'],
    [403, 'InvalidProviderToken', 'cert'],
    [403, 'ExpiredProviderToken', 'cert'],
  ])('maps %i %s to %s', async (status, reason, outcome) => {
    stubFetch(() => new Response(JSON.stringify({ reason }), { status }));
    const [result] = await createApnsTransport(env).send(target('TEAMAAAAAA'), ['t'], 0);
    expect(result).toMatchObject({ status, reason });
    expect(classifyApns(result as never)).toBe(outcome);
  });

  it('probes with the key: healthy on BadDeviceToken, failing on InvalidProviderToken', async () => {
    const ctx = createServiceContext(env);
    stubFetch(() => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }));
    expect(await probeApns(ctx, null, a)).toMatchObject({ health: 'healthy', method: 'key' });
    const row = await getIdentityRow(env.DB, a);
    expect(row?.apns_health).toBe('healthy');
    clearApnsTokens();
    stubFetch(
      () => new Response(JSON.stringify({ reason: 'InvalidProviderToken' }), { status: 403 }),
    );
    expect(await probeApns(ctx, null, a)).toMatchObject({
      health: 'failing',
      reason: 'InvalidProviderToken',
    });
    const audit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE action = 'identity.apns_probe' AND target_id = ? ORDER BY at DESC, id DESC LIMIT 1",
      [a],
    );
    expect(audit?.detail).toContain('"method":"key"');
  });

  it('logs APNS_TOKEN_TRANSPORT_FAILED when the key path cannot reach Apple', async () => {
    const events: { event: string; data?: LogData }[] = [];
    const base = createLogger({});
    const log = { ...base, error: (event: string, data?: LogData) => events.push({ event, data }) };
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('h2 unsupported'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createServiceContext(env, { log: log as never });
    expect(await probeApns(ctx, null, a)).toMatchObject({
      health: 'failing',
      status: 0,
      reason: 'NetworkError:TypeError',
    });
    expect(events.some((e) => e.data?.code === 'APNS_TOKEN_TRANSPORT_FAILED')).toBe(true);
  });

  it('reports unavailable for a team without a key', async () => {
    expect(await probeApns(createServiceContext(env), null, b)).toMatchObject({
      health: 'unavailable',
      method: 'none',
    });
  });

  it('shows the method in the status component', async () => {
    const row = await getIdentityRow(env.DB, a);
    if (!row) throw new Error('missing');
    const ctx = createServiceContext(env);
    const withKey = identityComponent(ctx, row, null, new Set(['TEAMAAAAAA']));
    expect(withKey.data).toMatchObject({ pushMethod: 'key' });
    expect(withKey.detail).not.toContain('Push unavailable');
    const none = identityComponent(ctx, row, null, new Set());
    expect(none.data).toMatchObject({ pushMethod: 'none' });
    expect(none.detail).toContain('no APNs binding or push key');
  });
});
