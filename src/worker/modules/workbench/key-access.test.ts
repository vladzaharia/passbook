import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WORKBENCH_KEY_MAX_MS } from '../../../shared/contracts/workbench.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const day = 86_400_000;

/** What the Keys tool may offer, by token: list, create a capped key, rotate it. */
async function matrix(token: string, orgId: string) {
  const now = t.kit.clock.now();
  const client = t.asClient(token);
  const list = await t.call('GET', `/api-keys?orgId=${orgId}`, client);
  const create = await t.call('POST', '/api-keys', client, {
    orgId,
    name: 'CI',
    kind: 'service',
    scopes: ['passes:read'],
    expiresAt: now + 7 * day,
  });
  const made = create.status === 201 ? ((await create.clone().json()) as { id: string }) : null;
  const rotate = made
    ? await t.call('POST', `/api-keys/${made.id}/rotate`, client, { orgId, overlapHours: 1 })
    : null;
  return {
    list: list.status,
    create: create.status,
    rotate: rotate?.status ?? null,
    why: create.status === 201 ? '' : await create.clone().text(),
  };
}

/**
 * The Keys tool's access matrix (design T4). `canManage` and the list's visibility in the web tool follow
 * these answers: a sandbox token holds no key scopes at all; a member's token follows the member's
 * `integrations:*` capabilities, inside S1's cap (Test, Test-data scopes, 30 days).
 */
describe('Keys access by Workbench token', () => {
  it('a sandbox token lists, makes a capped key and rotates it', async () => {
    const d = await t.developer();
    const { token } = await t.wbMint(d.browser, d.made.orgId);
    const m = await matrix(token, d.made.orgId);
    expect(m, JSON.stringify(m)).toMatchObject({ list: 200, create: 201, rotate: 201 });
  });

  it('a sandbox token holds the cap, revokes capped keys, and never reaches its own key', async () => {
    const d = await t.developer();
    const { token } = await t.wbMint(d.browser, d.made.orgId);
    const orgId = d.made.orgId;
    const client = t.asClient(token);
    const now = t.kit.clock.now();
    const body = { orgId, name: 'X', kind: 'service', scopes: ['passes:read'] };
    const make = (extra: object) => t.call('POST', '/api-keys', client, { ...body, ...extra });
    const made = await make({ expiresAt: now + day });
    expect(made.status, await made.clone().text()).toBe(201);
    const { id } = (await made.json()) as { id: string };
    // Uncapped: wider scope, role preset, no or long expiry, Live.
    for (const extra of [
      { scopes: ['passes:read', 'brand:manage'], expiresAt: now + day },
      { scopes: [], roles: ['org_admin'], expiresAt: now + day },
      { expiresAt: null },
      { expiresAt: now + WORKBENCH_KEY_MAX_MS + day },
      { mode: 'live', expiresAt: now + day },
    ])
      expect((await make(extra)).status, JSON.stringify(extra)).toBe(403);
    // Revoke a capped key; the token's own key is not found for revoke and rotate.
    expect((await t.call('DELETE', `/api-keys/${id}?orgId=${orgId}`, client)).status).toBe(200);
    const ownId = d.key.id;
    expect((await t.call('DELETE', `/api-keys/${ownId}?orgId=${orgId}`, client)).status).toBe(404);
    expect(
      (await t.call('POST', `/api-keys/${ownId}/rotate`, client, { orgId, overlapHours: 1 }))
        .status,
    ).toBe(404);
    expect((await t.call('POST', '/api-keys/me/rotate', client, { overlapHours: 1 })).status).toBe(
      404,
    );
  });

  it('an org admin token lists, makes a capped Test key and rotates it', async () => {
    const m0 = await t.member(['org_admin']);
    const { token } = await t.wbMint(m0.browser, m0.orgId);
    expect(await matrix(token, m0.orgId)).toMatchObject({ list: 200, create: 201, rotate: 201 });
    // The cap holds: no Live key, no uncapped expiry.
    const client = t.asClient(token);
    const body = { orgId: m0.orgId, name: 'X', kind: 'service', scopes: ['passes:read'] };
    const now = t.kit.clock.now();
    const live = await t.call('POST', '/api-keys', client, {
      ...body,
      mode: 'live',
      expiresAt: now + day,
    });
    expect(live.status).toBe(403);
    const long = await t.call('POST', '/api-keys', client, {
      ...body,
      expiresAt: now + WORKBENCH_KEY_MAX_MS + day,
    });
    expect(long.status).toBe(403);
  });

  it('a read-only member token follows the role: no key management', async () => {
    const m0 = await t.member(['read_only']);
    const { token } = await t.wbMint(m0.browser, m0.orgId);
    const m = await matrix(token, m0.orgId);
    expect(m.create).toBe(403);
    expect(m.rotate).toBeNull();
    // It still reads the list (`integrations:read`).
    expect(m.list).toBe(200);
  });
});
