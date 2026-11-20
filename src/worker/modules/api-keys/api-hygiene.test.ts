import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fakeRateLimiter,
  makeApiKey,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { ApiKeyMeSchema } from '../../../shared/contracts/index.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { inboxApp } from '../sandbox/test-tenant-fixtures.ts';

let kit: Kit;
let app: ReturnType<typeof inboxApp>;
let key: Awaited<ReturnType<typeof makeApiKey>>;

beforeAll(async () => {
  kit = await setupKit({ env: { RL_API_KEY: fakeRateLimiter({ limit: 3 }) } });
  app = inboxApp(kit);
  key = await makeApiKey(kit.fx, {
    orgId: kit.org.id,
    mode: 'test',
    scopes: ['passes:read', 'templates:read'],
    name: 'CI key',
  });
});

const call = (path: string, headers: Record<string, string> = key.headers) =>
  app.request(`https://wallet.test${path}`, { headers }, kit.env);

describe('GET /api-keys/me', () => {
  it('describes the calling key and never its secret or hash', async () => {
    const res = await call('/api/v1/api-keys/me');
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = ApiKeyMeSchema.strict().parse(JSON.parse(text));
    expect(body).toMatchObject({
      id: key.id,
      name: 'CI key',
      orgId: kit.org.id,
      mode: 'test',
      scopes: ['passes:read', 'templates:read'],
    });
    expect(typeof body.createdAt).toBe('number');
    expect(text).not.toContain(key.secret);
    expect(text).not.toMatch(/key_hash|secret/);
  });

  it('refuses a missing or invalid key', async () => {
    await expectProblem(await call('/api/v1/api-keys/me', {}), 401, 'INVALID_API_KEY');
    await expectProblem(
      await call('/api/v1/api-keys/me', { authorization: 'Bearer wlt_nope' }),
      401,
      'INVALID_API_KEY',
    );
  });
});

describe('rate-limit headers', () => {
  it('sends the budget on success and Retry-After on 429', async () => {
    const own = await makeApiKey(kit.fx, { orgId: kit.org.id, mode: 'test' });
    const ok = await call('/api/v1/api-keys/me', own.headers);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('ratelimit-policy')).toBe('600;w=60');
    expect(ok.headers.get('ratelimit-limit')).toBe('600');
    expect(Number(ok.headers.get('ratelimit-reset'))).toBeGreaterThanOrEqual(1);
    await call('/api/v1/api-keys/me', own.headers);
    await call('/api/v1/api-keys/me', own.headers);
    const limited = await call('/api/v1/api-keys/me', own.headers);
    expect(limited.status).toBe(429);
    const retry = Number(limited.headers.get('retry-after'));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(limited.headers.get('ratelimit-remaining')).toBe('0');
    expect(limited.headers.get('ratelimit-reset')).toBe(String(retry));
    expect(limited.headers.get('ratelimit-policy')).toBe('600;w=60');
  });
});

describe('OpenAPI document', () => {
  it('is served at /api/v1/docs with security schemes and per-route scopes', async () => {
    const res = await call('/api/v1/docs', {});
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      components: { securitySchemes: Record<string, { type: string; scheme?: string }> };
      paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
    };
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.components.securitySchemes.session?.type).toBe('apiKey');
    const scopes = (path: string, method: string) =>
      doc.paths[path]?.[method]?.security?.flatMap((s) => s.apiKey ?? []);
    expect(scopes('/api/v1/passes', 'get')).toEqual(['passes:read']);
    expect(scopes('/api/v1/passes', 'post')).toEqual(['passes:write']);
    expect(scopes('/api/v1/test-inbox', 'get')).toEqual(['passes:read']);
    expect(doc.paths['/api/v1/api-keys/me']?.get?.security).toEqual([
      { apiKey: [] },
      { session: [] },
    ]);
    // The alias serves the same document.
    expect(await (await call('/api/v1/openapi.json', {})).json()).toEqual(doc);
  });

  it('lists only key-callable operations publicly; the whole document needs an admin session', async () => {
    type Doc = { paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>> };
    const pub = (await (await call('/api/v1/docs', {})).json()) as Doc;
    expect(pub.paths['/api/v1/orgs']).toBeUndefined();
    expect(pub.paths['/api/v1/passes']).toBeDefined();
    // The preview frame is session-only, so a key never sees it.
    expect(pub.paths['/api/v1/test-inbox/{id}/html']).toBeUndefined();
    expect(pub.paths['/api/v1/test-inbox/{id}']?.get).toBeDefined();
    const admin = await makeSession(kit.fx, {
      userId: (await makeUser(kit.fx)).id,
      roles: ['admin', 'user'],
    });
    const full = (await (await call('/api/v1/docs', admin.headers)).json()) as Doc;
    expect(full.paths['/api/v1/orgs']).toBeDefined();
    expect(full.paths['/api/v1/test-inbox/{id}/html']?.get).toBeDefined();
    expect(full.paths['/api/v1/test-inbox/{id}/html']?.get?.security).toEqual([{ session: [] }]);
    const user = await makeSession(kit.fx, { userId: (await makeUser(kit.fx)).id });
    expect(
      ((await (await call('/api/v1/docs', user.headers)).json()) as Doc).paths['/api/v1/orgs'],
    ).toBeUndefined();
  });
});

describe('GET /delivery', () => {
  it('lets an org-bound key omit orgId; a platform key must send it', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const bound = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      mode: 'test',
      scopes: ['passes:read'],
    });
    const res = await call(`/api/v1/delivery?passId=${pass.id}`, bound.headers);
    expect(res.status).toBe(200);
    const platform = await makeApiKey(kit.fx, {
      orgId: null,
      mode: 'test',
      scopes: ['passes:read'],
    });
    await expectProblem(
      await call(`/api/v1/delivery?passId=${pass.id}`, platform.headers),
      422,
      'ORG_REQUIRED',
    );
  });
});
