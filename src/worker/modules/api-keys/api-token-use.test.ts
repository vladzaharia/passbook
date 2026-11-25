import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { fakeRateLimiter, makeApiKey, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from './service.ts';
import {
  type CreatedKey,
  create,
  f,
  h,
  keyBody,
  member,
  org,
  setup,
  teardown,
} from './test-kit.ts';

beforeEach(async () => {
  await setup();
  await run(h.env.DB, 'DELETE FROM api_keys');
});
afterEach(teardown);

const IN = '198.51.100.7';
const NET = ['198.51.100.0/24', '2001:db8::/32'];
const bearer = (secret: string, ip?: string) => ({
  authorization: `Bearer ${secret}`,
  ...(ip ? { 'cf-connecting-ip': ip } : {}),
});
const listPasses = (headers: Record<string, string>) => h.call('/api/v1/passes', { headers });

describe('IP allowlist', () => {
  it('admits an address in the list, refuses every other and an unknown one', async () => {
    const k = await makeApiKey(f(), { orgId: org.id, ipAllow: NET });
    const store = createApiKeyStore(h.env, h.clock);
    for (const ip of [IN, '2001:db8:0:1::9', '::ffff:198.51.100.200'])
      expect(await store.resolve(k.secret, { ip }), ip).not.toBeNull();
    for (const ip of ['198.51.101.7', '2001:db9::1', '203.0.113.9', 'unknown', '', undefined])
      expect(await store.resolve(k.secret, { ip }), String(ip)).toBeNull();
    expect(await store.resolve(k.secret)).toBeNull();
  });

  it('a key with no allowlist takes any address, and none', async () => {
    const k = await makeApiKey(f(), { orgId: org.id });
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(k.secret, { ip: '203.0.113.9' })).not.toBeNull();
    expect(await store.resolve(k.secret)).not.toBeNull();
  });

  it('answers a wrong address exactly as it answers a wrong key', async () => {
    const k = await makeApiKey(f(), { orgId: org.id, ipAllow: NET });
    const wrongIp = await listPasses(bearer(k.secret, '203.0.113.9'));
    const wrongKey = await listPasses(bearer(`${k.secret.slice(0, -1)}x`, IN));
    expect(wrongIp.status).toBe(401);
    const body = async (r: Response) => ({ ...((await r.json()) as object), requestId: 'x' });
    expect(await body(wrongIp)).toEqual(await body(wrongKey));
    expect((await listPasses(bearer(k.secret, IN))).status).toBe(200);
  });

  it('reads only cf-connecting-ip, never a header the caller can set', async () => {
    const k = await makeApiKey(f(), { orgId: org.id, ipAllow: NET });
    for (const spoof of ['x-forwarded-for', 'x-real-ip', 'forwarded'])
      expect((await listPasses({ ...bearer(k.secret), [spoof]: IN })).status, spoof).toBe(401);
    expect((await listPasses(bearer(k.secret, '203.0.113.9'))).status).toBe(401);
  });

  it('is checked for a platform key too, and records the network, not the address', async () => {
    const k = await makeApiKey(f(), {
      orgId: null,
      kind: 'platform',
      expiresAt: h.clock.now() + 86_400_000,
      ipAllow: ['198.51.100.0/24'],
    });
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(k.secret, { ip: '203.0.113.9' })).toBeNull();
    expect(await store.resolve(k.secret, { ip: IN })).not.toBeNull();
    expect(
      await first(h.env.DB, 'SELECT last_ip_prefix AS p FROM api_keys WHERE id = ?', [k.id]),
    ).toEqual({ p: '198.51.100.0/24' });
  });

  it('refuses a wrong address before it charges the key budget', async () => {
    const limiter = fakeRateLimiter({ limit: 100 });
    const env = await makeEnv({ RL_API_KEY: limiter });
    const k = await makeApiKey(f(), { orgId: org.id, ipAllow: NET });
    const store = createApiKeyStore(env, h.clock);
    await store.resolve(k.secret, { ip: '203.0.113.9' });
    expect(limiter.counts.size).toBe(0);
    await store.resolve(k.secret, { ip: IN });
    expect(limiter.counts.get(`key:${k.id}`)).toBe(1);
  });

  it('is set at mint: stored once, listed, and a malformed range is refused', async () => {
    const { session } = await member('org_admin');
    const res = await create(session.headers, {
      ...keyBody(org.id),
      ipAllow: [' 198.51.100.0/24 ', '198.51.100.0/24'],
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as CreatedKey & { ipAllow: string[] }).ipAllow).toEqual([
      '198.51.100.0/24',
    ]);
    for (const bad of ['198.51.100.7/24', 'nope', '1.2.3.4/33', '*'])
      await expectProblem(
        await create(session.headers, { ...keyBody(org.id), ipAllow: [bad] }),
        422,
        'API_KEY_IP_INVALID',
      );
    // Too broad: one wide range, or ranges that together cover every address.
    for (const wide of [
      ['0.0.0.0/0'],
      ['::/0'],
      ['10.0.0.0/7'],
      ['2001::/16'],
      ['0.0.0.0/1', '128.0.0.0/1'],
    ])
      await expectProblem(
        await create(session.headers, { ...keyBody(org.id), ipAllow: wide }),
        422,
        'API_KEY_IP_TOO_BROAD',
      );
    expect(
      (
        await create(session.headers, {
          ...keyBody(org.id),
          ipAllow: ['10.0.0.0/8', '2001:db8::/32'],
        })
      ).status,
    ).toBe(201);
  });
});

describe('a platform key made before 0142', () => {
  it('keeps working without expiry or IP list, and each use is logged', async () => {
    const k = await makeApiKey(f(), { orgId: null });
    const seen: string[] = [];
    const spy = vi
      .spyOn(console, 'warn')
      .mockImplementation((line) => void seen.push(String(line)));
    try {
      const store = createApiKeyStore(h.env, h.clock);
      expect(await store.resolve(k.secret)).toMatchObject({ orgId: null });
      expect(await store.resolve(k.secret)).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(seen.filter((l) => l.includes('API_KEY_PLATFORM_UNBOUNDED'))).toHaveLength(2);
    // A bounded platform key is not logged.
    const bounded = await makeApiKey(f(), {
      orgId: null,
      expiresAt: h.clock.now() + 86_400_000,
      ipAllow: ['198.51.100.0/24'],
    });
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await createApiKeyStore(h.env, h.clock).resolve(bounded.secret, { ip: IN });
      expect(quiet.mock.calls.flat().join()).not.toContain('API_KEY_PLATFORM_UNBOUNDED');
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('restricted keys', () => {
  const templateOf = async (orgId: string) => {
    const id = f().ids.id();
    await run(
      h.env.DB,
      `INSERT INTO templates (id, org_id, slug, name, origin, created_at, updated_at)
       VALUES (?, ?, ?, 'T', 'uploaded', 1, 1)`,
      [id, orgId, id],
    );
    return id;
  };

  it('stores the templates and styles with the key and lists them', async () => {
    const { session } = await member('org_admin');
    const templateId = await templateOf(org.id);
    const res = await create(session.headers, {
      ...keyBody(org.id),
      scopes: ['passes:read', 'passes:write'],
      templateIds: [templateId],
      passStyles: ['coupon'],
    });
    expect(res.status).toBe(201);
    const key = (await res.json()) as CreatedKey & { templateIds: string[]; passStyles: string[] };
    expect(key).toMatchObject({ templateIds: [templateId], passStyles: ['coupon'] });
    expect(await first(h.env.DB, 'SELECT restricted FROM api_keys WHERE id = ?', [key.id])).toEqual(
      { restricted: 1 },
    );
    const listed = await (
      await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers: session.headers })
    ).json();
    expect(
      (listed as { items: { id: string; templateIds: string[] }[] }).items.find(
        (i) => i.id === key.id,
      ),
    ).toMatchObject({
      templateIds: [templateId],
    });
  });

  it('is refused on a route that does not enforce the limit, with nothing exposed', async () => {
    const { session } = await member('org_admin');
    const res = await create(session.headers, {
      ...keyBody(org.id),
      scopes: ['passes:read'],
      templateIds: [await templateOf(org.id)],
    });
    const key = (await res.json()) as CreatedKey;
    await expectProblem(await listPasses(bearer(key.secret)), 403, 'API_KEY_RESTRICTED_ROUTE');
    // Only the key's own description (`/me`) takes it: it reads the key row, nothing of the org's data.
    const me = await h.call('/api/v1/api-keys/me', { headers: bearer(key.secret) });
    expect(me.status).toBe(200);
  });

  it("refuses another org's template, platform keys, roles and scopes no template narrows", async () => {
    const { session } = await member('org_admin');
    const other = await makeOrg(f());
    const body = (over: object) => ({ ...keyBody(org.id), scopes: ['passes:read'], ...over });
    const foreign = await templateOf(other.id);
    for (const id of [foreign, 'nope'])
      await expectProblem(
        await create(session.headers, body({ templateIds: [id] })),
        409,
        'API_KEY_TEMPLATE_UNKNOWN',
      );
    for (const over of [{ scopes: ['connections:read'] }, { scopes: [], roles: ['pass_operator'] }])
      await expectProblem(
        await create(session.headers, body({ ...over, templateIds: [await templateOf(org.id)] })),
        422,
        'API_KEY_RESTRICTION_UNSUPPORTED',
      );
    expect(await first(h.env.DB, 'SELECT 1 FROM api_keys WHERE restricted = 1')).toBeNull();
  });
});

describe('role tokens', () => {
  it('mints an org_admin role token in test mode, with no credential scope', async () => {
    const { session } = await member('org_admin');
    const res = await create(
      { ...session.headers, 'x-passbook-mode': 'test' },
      { ...keyBody(org.id), scopes: [], roles: ['org_admin'], mode: 'test' },
    );
    expect(res.status).toBe(201);
    const key = (await res.json()) as CreatedKey & { scopes: string[] };
    expect(key.scopes).toContain('scanning:write');
    expect(key.scopes).not.toContain('scanning:admin');
  });
});

describe('rate tier', () => {
  it("charges the key's own tier binding, and follows the environment default when unset", async () => {
    const high = fakeRateLimiter({ limit: 100 });
    const std = fakeRateLimiter({ limit: 100 });
    const env = await makeEnv({ RL_API_KEY: std, RL_API_KEY_HIGH: high });
    const tiered = await makeApiKey(f(), { orgId: org.id, rateTier: 'high' });
    const plain = await makeApiKey(f(), { orgId: org.id });
    const store = createApiKeyStore(env, h.clock);
    await store.resolve(tiered.secret);
    await store.resolve(plain.secret);
    expect(high.counts.get(`key:${tiered.id}`)).toBe(1);
    expect(std.counts.get(`key:${plain.id}`)).toBe(1);
    expect(std.counts.has(`key:${tiered.id}`)).toBe(false);
    const dflt = await makeEnv({ API_RATE_TIER_DEFAULT: 'high', RL_API_KEY_HIGH: high } as never);
    await createApiKeyStore(dflt, h.clock).resolve(plain.secret);
    expect(high.counts.get(`key:${plain.id}`)).toBe(1);
  });

  it('is not settable at mint', async () => {
    const { session } = await member('org_admin');
    const res = await create(session.headers, { ...keyBody(org.id), rateTier: 'bulk' });
    const key = (await res.json()) as CreatedKey;
    expect(
      await first(h.env.DB, 'SELECT rate_tier AS t FROM api_keys WHERE id = ?', [key.id]),
    ).toEqual({ t: null });
  });
});

describe('a key refused at the route gate', () => {
  it('logs a stable code on the one request.done line: the prefix of an unknown key, the id of a known key without the scope', async () => {
    const k = await makeApiKey(f(), { orgId: org.id, scopes: ['passes:write'] });
    const seen: string[] = [];
    const spy = vi
      .spyOn(console, 'info')
      .mockImplementation((line) => void seen.push(String(line)));
    try {
      await expectProblem(
        await listPasses(bearer(`${k.secret.slice(0, -1)}${k.secret.endsWith('A') ? 'B' : 'A'}`)),
        401,
        'INVALID_API_KEY',
      );
      await expectProblem(await listPasses(bearer(k.secret)), 403, 'MISSING_SCOPE');
    } finally {
      spy.mockRestore();
    }
    const logs = seen
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'request.done' && l.code !== undefined);
    expect(seen.filter((l) => l.includes('auth.key_refused'))).toEqual([]);
    expect(logs.map((l) => l.code)).toEqual(['INVALID_API_KEY', 'MISSING_SCOPE']);
    expect(logs[0]).toMatchObject({ keyPrefix: k.secret.slice(4, 12) });
    expect(logs[1]).toMatchObject({ keyId: k.id, scope: 'passes:read' });
    // The token itself is never logged.
    expect(seen.join()).not.toContain(k.secret.slice(-12));
  });
});

describe('a header with no key on the other key guards', () => {
  it.each(['/api/v1/api-keys/me', '/api/v1/developer/logs'])(
    '%s answers API_KEY_MISSING for an empty Bearer',
    async (path) => {
      for (const authorization of ['Bearer', 'Bearer undefined']) {
        const res = await h.call(path, { headers: { authorization } });
        expect(res.status).toBe(401);
        expect(((await res.json()) as { code: string }).code).toBe('API_KEY_MISSING');
      }
    },
  );
});

describe('a key refused by the other key guards', () => {
  it('adds the same code to request.done: /me and the try-token logs', async () => {
    const seen: string[] = [];
    const spy = vi
      .spyOn(console, 'info')
      .mockImplementation((line) => void seen.push(String(line)));
    const bad = `Bearer pb_live_ABCDEFGH_${'0123456789'.repeat(4)}012`;
    try {
      expect(
        (await h.call('/api/v1/api-keys/me', { headers: { authorization: bad } })).status,
      ).toBe(401);
      const logs = await h.call('/api/v1/developer/logs', {
        headers: { authorization: 'Bearer pbtry_nope.nope' },
      });
      expect(logs.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
    const done = seen
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'request.done' && l.code === 'INVALID_API_KEY');
    expect(done.map((l) => l.route).sort()).toEqual(
      ['/api/v1/api-keys/me', '/api/v1/developer/logs'].sort(),
    );
    expect(done.find((l) => l.route === '/api/v1/api-keys/me')?.keyPrefix).toBe('ABCDEFGH');
  });
});
