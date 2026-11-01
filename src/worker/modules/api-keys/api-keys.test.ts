import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { fakeLimiter, harness, type TestHarness } from '../auth/test-support.ts';
import { createApiKeyStore } from './service.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);

beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

async function adminHeaders() {
  const user = await makeUser(f());
  const s = await makeSession(f(), { userId: user.id, roles: ['admin', 'user'] });
  return { headers: s.headers, userId: user.id };
}

interface Created {
  id: string;
  secret: string;
  prefix: string;
  scopes: string[];
  orgId: string | null;
  createdBy: string;
}

async function create(body: object) {
  const { headers, userId } = await adminHeaders();
  const res = await h.call('/api/v1/api-keys', { method: 'POST', json: body, headers });
  return { res, headers, userId, key: (await res.clone().json()) as Created };
}

describe('create', () => {
  it('returns the secret once and stores only a hash', async () => {
    const { res, key, userId } = await create({ name: 'CI', scopes: ['passes:read'] });
    expect(res.status).toBe(201);
    expect(key.secret).toMatch(/^wlt_[\w-]{8}_[\w-]{43}$/);
    expect(key.secret.startsWith(`wlt_${key.prefix}_`)).toBe(true);
    expect(key.createdBy).toBe(userId);
    const row = await first<{ key_hash: string }>(
      h.env.DB,
      'SELECT key_hash FROM api_keys WHERE id = ?',
      [key.id],
    );
    expect(row?.key_hash).toBe(await sha256Hex(key.secret));
    const { headers } = await adminHeaders();
    const listed = (await (await h.call('/api/v1/api-keys', { headers })).json()) as {
      items: Record<string, unknown>[];
    };
    const item = listed.items.find((i) => i.id === key.id);
    expect(item).toBeTruthy();
    // makeUser sets no name, so the chip shows the creator's email.
    expect(item?.createdByName).toBe(`${userId}@example.com`);
    expect(JSON.stringify(listed)).not.toContain(key.secret);
  });

  it('audits creation without the secret', async () => {
    const { key } = await create({ name: 'Audit', scopes: ['passes:read'] });
    const audit = await first<{ detail: string }>(
      h.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'api_key.create' AND target_id = ?",
      [key.id],
    );
    expect(audit?.detail).not.toContain(key.secret);
  });

  it('rejects unknown scopes, empty scope lists and past expiry', async () => {
    expect((await create({ name: 'x', scopes: ['admin:all'] })).res.status).toBe(422);
    expect((await create({ name: 'x', scopes: [] })).res.status).toBe(422);
    const past = await create({ name: 'x', scopes: ['passes:read'], expiresAt: 1 });
    expect(past.res.status).toBe(422);
  });

  it('scopes a key to an existing org only', async () => {
    const org = await makeOrg(f());
    const ok = await create({ name: 'o', scopes: ['passes:read'], orgId: org.id });
    expect(ok.key.orgId).toBe(org.id);
    const missing = await create({ name: 'o', scopes: ['passes:read'], orgId: 'nope' });
    expect(missing.res.status).toBe(404);
  });

  it('is admin-only and needs CSRF', async () => {
    const user = await makeUser(f());
    const s = await makeSession(f(), { userId: user.id, roles: ['user'] });
    const body = { name: 'x', scopes: ['passes:read'] };
    expect(
      (await h.call('/api/v1/api-keys', { method: 'POST', json: body, headers: s.headers })).status,
    ).toBe(403);
    const { headers } = await adminHeaders();
    const noCsrf = { cookie: headers.cookie ?? '' };
    expect(
      (await h.call('/api/v1/api-keys', { method: 'POST', json: body, headers: noCsrf })).status,
    ).toBe(403);
    const key = await makeApiKey(f(), { scopes: ['passes:read'] });
    expect(
      (await h.call('/api/v1/api-keys', { method: 'POST', json: body, headers: key.headers }))
        .status,
    ).toBe(401);
  });
});

describe('use', () => {
  const probe = (headers: Record<string, string>, method = 'GET') =>
    h.call('/api/v1/passes', { method, headers }).then((r) => r.status);

  it('authenticates a created key and enforces scopes', async () => {
    const { key } = await create({ name: 'reader', scopes: ['passes:read'] });
    const headers = { authorization: `Bearer ${key.secret}` };
    expect([401, 403, 429]).not.toContain(await probe(headers));
    const write = await h.call('/api/v1/passes', {
      method: 'POST',
      headers,
      json: {},
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe('MISSING_SCOPE');
    const tmpl = await h.call('/api/v1/templates', { headers });
    expect(tmpl.status).toBe(403);
  });

  it('rejects malformed, wrong and revoked keys', async () => {
    const { key, headers: admin } = await create({ name: 'k', scopes: ['passes:read'] });
    const bearer = (s: string) => ({ authorization: `Bearer ${s}` });
    expect(await probe(bearer('garbage'))).toBe(401);
    const tampered = `${key.secret.slice(0, -1)}${key.secret.endsWith('A') ? 'B' : 'A'}`;
    expect(await probe(bearer(tampered))).toBe(401);
    const revoke = await h.call(`/api/v1/api-keys/${key.id}`, { method: 'DELETE', headers: admin });
    expect(revoke.status).toBe(200);
    expect(await probe(bearer(key.secret))).toBe(401);
    expect(
      (await h.call(`/api/v1/api-keys/${key.id}`, { method: 'DELETE', headers: admin })).status,
    ).toBe(200);
    expect(
      (await h.call('/api/v1/api-keys/nope', { method: 'DELETE', headers: admin })).status,
    ).toBe(404);
  });

  it('rejects expired keys', async () => {
    const { key } = await create({
      name: 'short',
      scopes: ['passes:read'],
      expiresAt: h.clock.now() + 60_000,
    });
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(key.secret)).not.toBeNull();
    h.clock.advance(61_000);
    expect(await store.resolve(key.secret)).toBeNull();
  });

  it('rejects keys of suspended or missing orgs', async () => {
    const org = await makeOrg(f());
    const { key } = await create({ name: 'o', scopes: ['passes:read'], orgId: org.id });
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(key.secret)).toMatchObject({ orgId: org.id });
    await run(h.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    expect(await store.resolve(key.secret)).toBeNull();
  });

  it('works with keys inserted by the shared test factory', async () => {
    const fixture = await makeApiKey(f(), { scopes: ['passes:read'] });
    const auth = await createApiKeyStore(h.env, h.clock).resolve(fixture.secret);
    expect(auth).toMatchObject({ kind: 'api_key', keyId: fixture.id, scopes: ['passes:read'] });
  });

  it('throttles last_used writes', async () => {
    const { key } = await create({ name: 'k', scopes: ['passes:read'] });
    const store = createApiKeyStore(h.env, h.clock);
    const used = async () =>
      (
        await first<{ last_used_at: number | null }>(
          h.env.DB,
          'SELECT last_used_at FROM api_keys WHERE id = ?',
          [key.id],
        )
      )?.last_used_at;
    await store.resolve(key.secret);
    const first1 = await used();
    expect(first1).toBe(h.clock.now());
    h.clock.advance(60_000);
    await store.resolve(key.secret);
    expect(await used()).toBe(first1);
    h.clock.advance(5 * 60_000);
    await store.resolve(key.secret);
    expect(await used()).toBe(h.clock.now());
  });

  it('rate limits per key with 429', async () => {
    h.restore();
    h = await harness({ RL_API_KEY: fakeLimiter(2) as unknown as RateLimit });
    const { key } = await create({ name: 'k', scopes: ['passes:read'] });
    const headers = { authorization: `Bearer ${key.secret}` };
    const other = await makeApiKey(f(), { scopes: ['passes:read'] });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await h.call('/api/v1/passes', { headers })).status);
    }
    expect(statuses.slice(0, 2)).not.toContain(429);
    expect(statuses.slice(2)).toEqual([429, 429]);
    expect((await h.call('/api/v1/passes', { headers: other.headers })).status).not.toBe(429);
  });
});
