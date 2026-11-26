import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { WORKBENCH_KEY_MAX_MS } from '../../../shared/contracts/workbench.ts';
import { first } from '../../platform/db.ts';
import { bearer, workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const day = 86_400_000;
type Member = Awaited<ReturnType<typeof t.member>>;

/** A Test service key the member makes in admin with their session. */
async function adminKey(m: Member, scopes: string[], expiresAt: number | null) {
  const res = await t.call(
    'POST',
    '/api-keys',
    { ...m.browser, 'x-passbook-mode': 'test' },
    { orgId: m.orgId, name: 'Admin', kind: 'service', mode: 'test', scopes, expiresAt },
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string };
}

describe('H1: a key made or rotated under a token holds Test data only and is short-lived', () => {
  it('refuses shared-state scopes, role presets, no expiry and an expiry past 30 days', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    const now = t.kit.clock.now();
    const mint = (body: object) =>
      t.call('POST', '/api-keys', t.asClient(token), {
        orgId: m.orgId,
        name: 'CI',
        kind: 'service',
        scopes: ['passes:read'],
        expiresAt: now + 7 * day,
        ...body,
      });
    // The R1 probe: each of these minted a durable key that wrote the brand kit or reached members.
    for (const scope of [
      'brand:manage',
      'org:write',
      'api-keys:write',
      'members:read',
      'templates:write',
      'wallet:write',
      'audit:read',
      'connections:write',
      'nfc:keys',
    ])
      await expectProblem(
        await mint({ scopes: ['passes:read', scope] }),
        403,
        'WORKBENCH_TEST_ONLY',
      );
    await expectProblem(
      await mint({ scopes: [], roles: ['org_admin'] }),
      403,
      'WORKBENCH_TEST_ONLY',
    );
    await expectProblem(await mint({ expiresAt: null }), 403, 'WORKBENCH_TEST_ONLY');
    await expectProblem(await mint({ expiresAt: undefined }), 403, 'WORKBENCH_TEST_ONLY');
    await expectProblem(
      await mint({ expiresAt: now + WORKBENCH_KEY_MAX_MS + 1 }),
      403,
      'WORKBENCH_TEST_ONLY',
    );
    const ok = await mint({
      scopes: [
        'passes:read',
        'passes:write',
        'holders:write',
        'templates:read',
        'webhooks:manage',
        'scans:read',
      ],
      expiresAt: now + WORKBENCH_KEY_MAX_MS,
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const made = (await ok.json()) as { id: string; mode: string; expiresAt: number };
    expect(made).toMatchObject({ mode: 'test', expiresAt: now + WORKBENCH_KEY_MAX_MS });
    // Admin, in its own session, keeps making wider keys.
    await adminKey(m, ['brand:manage'], null);
  });

  it('rotates only a key it could have made: a wider or longer-lived one is not found', async () => {
    const m = await t.member();
    const now = t.kit.clock.now();
    const wide = await adminKey(m, ['passes:read', 'brand:manage'], now + 7 * day);
    const forever = await adminKey(m, ['passes:read'], null);
    const capped = await adminKey(m, ['passes:read'], now + 7 * day);
    const { token } = await t.wbMint(m.browser, m.orgId);
    const rotate = (id: string) =>
      t.call('POST', `/api-keys/${id}/rotate`, t.asClient(token), {
        orgId: m.orgId,
        overlapHours: 1,
      });
    for (const key of [wide, forever])
      await expectProblem(await rotate(key.id), 404, 'API_KEY_NOT_FOUND');
    const res = await rotate(capped.id);
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe('v1 and sandbox tokens: no key rotation, no shared writes', () => {
  it('the try token and a sandbox token cannot rotate the sandbox key or write brand or org settings', async () => {
    const d = await t.developer();
    const v1 = (await t.mint(d.browser)).token;
    const v2 = (await t.wbMint(d.browser, d.made.orgId)).token;
    for (const token of [v1, v2]) {
      const page = { ...d.browser, ...bearer(token) };
      // The sandbox key holds no api-keys:write (its ceiling), so no token stands for a key that rotates.
      await expectProblem(
        await t.call('POST', '/api-keys/me/rotate', page, { overlapHours: 1 }),
        403,
        'MISSING_SCOPE',
      );
      await expectProblem(
        await t.call('PATCH', '/brand', page, { accent: '#ff0000' }),
        403,
        'WORKBENCH_TEST_ONLY',
      );
      // Cookie-only routes: the token rides along, so the cookie does not decide either (401).
      for (const [method, path, body] of [
        ['PATCH', `/orgs/${d.made.orgId}`, { name: 'Renamed' }],
        ['PUT', '/settings', { scope: 'org', orgId: d.made.orgId, values: {} }],
      ] as const) {
        const res = await t.call(method, path, page, body);
        expect([401, 403], `${method} ${path}`).toContain(res.status);
      }
    }
    const org = await first<{ name: string; branding: string | null }>(
      t.kit.env.DB,
      'SELECT name, branding FROM orgs WHERE id = ?',
      [d.made.orgId],
    );
    expect(org?.name).not.toBe('Renamed');
    expect(org?.branding ?? '').not.toContain('#ff0000');
  });
});
