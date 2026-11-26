import { beforeAll, describe, expect, it } from 'vitest';
import { key, ORIGIN, setupTillKit } from './guard-api-key-test-fixtures.ts';
import type { ScanKit } from './test-kit.ts';

let t: Awaited<ReturnType<typeof setupTillKit>>;
let kit: ScanKit;
beforeAll(async () => {
  t = await setupTillKit();
  kit = t.kit;
});

const OPEN = new Set([
  'post /api/v1/scan/resolve',
  'post /api/v1/scan/actions',
  'post /api/v1/scan/scans/{scanId}/undo',
  'post /api/v1/scan/sign-out',
]);
// The pairing routes read no credential: the router answers them before any scan guard.
const UNGUARDED = /^\/api\/v1\/scan\/(?:pair|unpair)/;

describe('every /api/v1/scan route, as a key', () => {
  it('opens resolve, actions, undo and sign-out only', async () => {
    const k = await t.till();
    const doc = (await (
      await t.app.request(`${ORIGIN}/api/v1/openapi.json`, { headers: t.adminHeaders }, kit.env)
    ).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const seen: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (!path.startsWith('/api/v1/scan/') || UNGUARDED.test(path)) continue;
      for (const method of Object.keys(ops).filter((m) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(m),
      )) {
        const url = path.replace(/\{[^}]+\}/g, 'x');
        const res = await t.app.request(
          `${ORIGIN}${url}`,
          {
            method: method.toUpperCase(),
            headers: { ...k.headers, 'content-type': 'application/json' },
            ...(method === 'get' || method === 'delete' ? {} : { body: '{}' }),
          },
          kit.env,
        );
        const code = ((await res.json().catch(() => ({}))) as { code?: string }).code;
        const open = OPEN.has(`${method} ${path}`);
        seen.push(`${method} ${path}`);
        if (open) expect(code, `${method} ${path}`).not.toBe('API_KEY_ROUTE');
        else
          expect([`${method} ${path}`, res.status, code]).toEqual([
            `${method} ${path}`,
            403,
            'API_KEY_ROUTE',
          ]);
      }
    }
    for (const route of OPEN) expect(seen).toContain(route);
    expect(seen.length).toBeGreaterThan(6);
  });
});

describe('origin checks on the scan router', () => {
  const cross = { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' };
  it('a cross-site cookie POST to /actions is CSRF_ORIGIN', async () => {
    const device = await kit.scanner({ templateIds: [t.templateId] });
    const pass = await kit.scanPass(t.templateId);
    const res = await t.call({ ...device.headers, ...cross }, '/actions', t.request(pass.id));
    expect([res.status, await t.outcomeCode(res)]).toEqual([403, 'CSRF_ORIGIN']);
  });

  it('cross-site /pair/preview and /unpair are CSRF_ORIGIN', async () => {
    for (const path of ['/pair/preview', '/unpair']) {
      const res = await t.call(cross, path, { code: 'ABCD-EFGH' });
      expect([path, res.status, await t.outcomeCode(res)]).toEqual([path, 403, 'CSRF_ORIGIN']);
    }
  });

  it('a wlt_ or wls_ bearer needs no Origin', async () => {
    const k = await t.till();
    const pass = await kit.scanPass(t.templateId);
    const viaKey = await t.call(k.headers, '/resolve', t.read(pass.id));
    expect(viaKey.status).toBe(200);
    const viaToken = await t.call(k.terminal.headers, '/resolve', {
      ...t.read(pass.id),
      idempotencyKey: key(),
    });
    expect(viaToken.status).toBe(200);
  });
});
