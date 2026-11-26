import { describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg } from '../../../test/helpers/index.ts';
import { PLATFORM_KEY_SCOPES } from '../../shared/contracts/api-keys.ts';
import { createApp } from '../app.ts';
import { ManualClock } from './clock.ts';
import { buildOpenApiDocument } from './openapi-document.ts';

type Op = {
  security?: Record<string, string[]>[];
  'x-public'?: true;
  'x-human-only'?: true | 'apply';
  'x-platform-scope'?: string;
  responses?: object;
};
type Doc = { paths: Record<string, Record<string, Op>> };

/** Refusals that name the credential, not the request or the data. */
const AUTH_CODES = new Set([
  'UNAUTHENTICATED',
  'API_KEY_MISSING',
  'INVALID_API_KEY',
  'MISSING_SCOPE',
  'SESSION_REQUIRED',
  'PLATFORM_KEY_REQUIRED',
  'PERSON_REQUIRED',
]);
const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const TOKENISH = /token|code|serial|passTypeId|provider|offer|key/i;
const NOT_ON_DOC = new Set(['trace', 'parameters', 'servers', 'summary', 'description']);

/** Operations whose session-only rule is the handler's: a request with an empty body fails validation first. */
const HANDLER_LEVEL_SESSION_ONLY = new Set([
  // removeCreated refuses keys (SESSION_REQUIRED); import-remove.test.ts proves it with a real draft.
  'post /api/v1/pass-imports/{id}/remove-created',
  // The test inbox guard lets a key through to the handler; only the list and one message accept one (sandbox/routes.ts).
  'get /api/v1/test-inbox/{id}/html',
  'post /api/v1/test-inbox/{id}/send-to-me',
]);

async function setup() {
  const fake = fakeAuth();
  const app = createApp({ stores: fake.stores });
  const env = await makeEnv();
  const clock = new ManualClock();
  fake.bindApiKeys(env, clock);
  const org = await makeOrg(fixtures(env, clock));
  const doc = buildOpenApiDocument(app) as unknown as Doc;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = async (method: string, path: string, headers: Record<string, string>) => {
    const url = `https://wallet.test${path.replace(/\{([^}]+)\}/g, (_m, n: string) =>
      TOKENISH.test(n) ? 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' : ID,
    )}`;
    const send = { ...headers, origin: 'https://wallet.test' } as Record<string, string>;
    const init: RequestInit = { method: method.toUpperCase(), headers: send };
    if (!['get', 'head', 'delete'].includes(method)) {
      send['content-type'] = 'application/json';
      init.body = '{}';
    }
    const res = await app.fetch(new Request(url, init), env, ctx);
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    return { status: res.status, code: body.code ?? '' };
  };
  return { fake, doc, call, orgId: org.id };
}

const refusesCredential = (r: { status: number; code: string }) =>
  r.status === 401 || (r.status === 403 && AUTH_CODES.has(r.code));

describe('OpenAPI document and guards agree', () => {
  it('lets a key with a documented scope past the guard, and refuses keys on session-only operations', async () => {
    const { fake, doc, call, orgId } = await setup();
    const keyWith = (scopes: string[]) => fake.apiKey({ orgId, scopes: scopes as never });
    const everything = fake.apiKey({
      orgId,
      scopes: [
        'passes:read',
        'passes:write',
        'holders:write',
        'templates:read',
        'messages:write',
        'scans:read',
        'scans:write',
        'connections:read',
        'connections:write',
        'webhooks:manage',
      ],
    });
    const wrong: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (NOT_ON_DOC.has(method)) continue;
        const name = `${method} ${path}`;
        const keySchemes = (op.security ?? []).filter((s) => 'apiKey' in s);
        if (keySchemes.length > 0) {
          for (const scheme of keySchemes) {
            const scopes = scheme.apiKey ?? [];
            const r = await call(method, path, keyWith(scopes));
            if (refusesCredential(r))
              wrong.push(
                `${name}: documented for key [${scopes.join(',')}], guard says ${r.status} ${r.code}`,
              );
          }
          continue;
        }
        if (!(op.security ?? []).some((s) => 'session' in s)) continue;
        if (HANDLER_LEVEL_SESSION_ONLY.has(name)) continue;
        const r = await call(method, path, everything);
        if (!refusesCredential(r) && r.status !== 403)
          wrong.push(`${name}: session-only in the document, a key got ${r.status} ${r.code}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 600_000);

  it('lets a Platform key past every platform operation documented for keys, and refuses it on the human-only ones', async () => {
    const { fake, doc, call } = await setup();
    const every = fake.platformKey({
      scopes: PLATFORM_KEY_SCOPES.filter((s) => s !== 'platform:read'),
    });
    const wrong: string[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item)) {
        const scope = op['x-platform-scope'];
        if (NOT_ON_DOC.has(method) || !scope) continue;
        const name = `${method} ${path}`;
        const documented = (op.security ?? []).filter((s) => 'apiKey' in s);
        for (const scheme of documented) {
          const r = await call(method, path, fake.platformKey({ scopes: scheme.apiKey as never }));
          if (refusesCredential(r))
            wrong.push(
              `${name}: documented for [${scheme.apiKey}], guard says ${r.status} ${r.code}`,
            );
        }
        if (op['x-human-only'] === true) {
          const r = await call(method, path, every);
          // PERSON_REQUIRED, or 401 where a session-only router guard (requireAdmin) answers first.
          if (r.status !== 401 && !(r.status === 403 && r.code === 'PERSON_REQUIRED'))
            wrong.push(`${name}: human-only, a Platform key got ${r.status} ${r.code}`);
        }
      }
    expect(wrong).toEqual([]);
  }, 600_000);

  it('documents the till, bulk print and import routes for keys', async () => {
    const { doc } = await setup();
    const scopesOf = (method: string, path: string) =>
      (doc.paths[path]?.[method]?.security ?? [])
        .filter((s) => 'apiKey' in s)
        .map((s) => s.apiKey?.[0]);
    for (const path of [
      '/api/v1/scan/resolve',
      '/api/v1/scan/actions',
      '/api/v1/scan/sign-out',
      '/api/v1/scan/scans/{scanId}/undo',
    ])
      expect(scopesOf('post', path)).toEqual(['scans:write']);
    expect(scopesOf('post', '/api/v1/passes/bulk-reissue')).toEqual(['passes:write']);
    expect(scopesOf('post', '/api/v1/passes/bulk-print')).toEqual(['passes:write']);
    expect(scopesOf('get', '/api/v1/passes/bulk-print/{jobId}')).toEqual(['passes:write']);
    expect(scopesOf('get', '/api/v1/passes/bulk-print/{jobId}/pdf')).toEqual(['passes:write']);
    expect(scopesOf('delete', '/api/v1/pass-imports/{id}')).toEqual(['passes:write']);
    expect(scopesOf('post', '/api/v1/pass-imports/{id}/remove-created')).toEqual([]);
  });

  it('gives every operation a security: guarded ones name a credential, open ones say so', async () => {
    const { doc } = await setup();
    const bad: string[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item)) {
        if (NOT_ON_DOC.has(method) || !op.responses) continue;
        const name = `${method} ${path}`;
        if (!Array.isArray(op.security)) bad.push(`${name}: no security`);
        else if (op.security.length === 0 && op['x-public'] !== true)
          bad.push(`${name}: empty security without x-public`);
        else if (op.security.length > 0 && op['x-public'] === true)
          bad.push(`${name}: x-public with a credential`);
      }
    expect(bad).toEqual([]);
  });

  it('answers a credential-less call to a public operation with something other than 401', async () => {
    const { doc, call } = await setup();
    const wrong: string[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item)) {
        if (NOT_ON_DOC.has(method) || op['x-public'] !== true) continue;
        const r = await call(method, path, {});
        if (r.status === 401) wrong.push(`${method} ${path}: public in the document, got 401`);
      }
    expect(wrong).toEqual([]);
  }, 600_000);
});
