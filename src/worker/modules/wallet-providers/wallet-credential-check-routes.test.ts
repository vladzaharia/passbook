import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeSession } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { systemClock } from '../../platform/clock.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  k = await kit();
  app = createApp({
    stores: {
      ...fakeAuth('https://wallet.test').stores,
      sessions: createSessionStore(k.env, systemClock),
    },
    clock: systemClock,
  });
}, 30_000);

async function call(headers: Record<string, string>, method: string, path: string, body?: unknown) {
  return app.request(
    `https://wallet.test${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    k.env,
  );
}

async function headers(
  userId: string,
  roles: ('admin' | 'user')[],
  mode: 'live' | 'test' = 'test',
) {
  const s = await makeSession(k.f, { userId, roles });
  return { ...s.headers, 'x-passbook-mode': mode };
}

describe('credential check routes', () => {
  it('queue a check and read its result handle; other orgs, modes and non-admins are refused', async () => {
    const a = await k.org();
    const b = await k.org();
    const ma = await k.member(a.id);
    const mb = await k.member(b.id);
    const ha = await headers(ma.user.id, ['user']);
    const hb = await headers(mb.user.id, ['user']);
    const put = await call(ha, 'PUT', `/api/v1/orgs/${a.id}/wallet-credentials`, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google(),
    });
    const { id } = (await put.json()) as { id: string };

    const queued = await call(ha, 'POST', `/api/v1/orgs/${a.id}/wallet-credentials/${id}/check`);
    expect(queued.status).toBe(200);
    const { checkId, status } = (await queued.json()) as { checkId: string; status: string };
    expect(status).toBe('queued');
    const read = await call(
      ha,
      'GET',
      `/api/v1/orgs/${a.id}/wallet-credentials/${id}/checks/${checkId}`,
    );
    expect(await read.json()).toEqual({ checkId, status: 'pending', code: null, checkedAt: null });

    // Org B: not a member of A, and A's credential id under B is not B's.
    expect(
      (await call(hb, 'POST', `/api/v1/orgs/${a.id}/wallet-credentials/${id}/check`)).status,
    ).toBe(403);
    expect(
      (await call(hb, 'POST', `/api/v1/orgs/${b.id}/wallet-credentials/${id}/check`)).status,
    ).toBe(404);
    expect(
      (await call(hb, 'GET', `/api/v1/orgs/${b.id}/wallet-credentials/${id}/checks/${checkId}`))
        .status,
    ).toBe(404);
    // The Live session does not see the Test credential.
    const live = await headers(ma.user.id, ['user'], 'live');
    expect(
      (await call(live, 'POST', `/api/v1/orgs/${a.id}/wallet-credentials/${id}/check`)).status,
    ).toBe(404);

    // The platform routes need an admin and only reach platform credentials.
    expect((await call(ha, 'POST', `/api/v1/platform/wallet-credentials/${id}/check`)).status).toBe(
      403,
    );
    const admin = await k.admin();
    const hAdmin = await headers(admin.user.id, ['admin', 'user']);
    expect(
      (await call(hAdmin, 'POST', `/api/v1/platform/wallet-credentials/${id}/check`)).status,
    ).toBe(404);
    const pput = await call(hAdmin, 'PUT', '/api/v1/platform/wallet-credentials', {
      provider: 'samsung',
      mode: 'test',
      expectedRevision: 0,
      credentials: k.samsung(),
    });
    const platformId = ((await pput.json()) as { id: string }).id;
    const pq = await call(
      hAdmin,
      'POST',
      `/api/v1/platform/wallet-credentials/${platformId}/check`,
    );
    expect(pq.status).toBe(200);
    const { checkId: pc } = (await pq.json()) as { checkId: string };
    expect(
      await (
        await call(hAdmin, 'GET', `/api/v1/platform/wallet-credentials/${platformId}/checks/${pc}`)
      ).json(),
    ).toMatchObject({ status: 'pending' });
  });
});
