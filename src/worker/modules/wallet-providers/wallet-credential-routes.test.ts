import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeSession } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { systemClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
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

const origin = 'https://wallet.test';
async function call(headers: Record<string, string>, method: string, path: string, body?: unknown) {
  return app.request(
    `${origin}${path}`,
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

/** Real cookie headers for a member or an admin (the routes resolve the session store). */
async function headers(userId: string, roles: ('admin' | 'user')[]) {
  const s = await makeSession(k.f, { userId, roles });
  return { ...s.headers, 'x-passbook-mode': 'test' };
}

describe('wallet credential and enrolment routes', () => {
  it('an org member saves a credential and walks the enrolment; secrets never come back', async () => {
    const org = await k.org();
    const m = await k.member(org.id);
    const h = await headers(m.user.id, ['user']);
    const put = await call(h, 'PUT', `/api/v1/orgs/${org.id}/wallet-credentials`, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google(),
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain(k.privateKey.slice(40, 80));
    const list = await call(h, 'GET', `/api/v1/orgs/${org.id}/wallet-credentials`);
    expect((await list.json()) as { items: unknown[] }).toMatchObject({
      items: [{ scope: 'org' }],
    });
    const source = await call(h, 'PUT', `/api/v1/orgs/${org.id}/wallet-enrolments/google`, {
      source: 'org',
      expectedRevision: 0,
    });
    expect(await source.json()).toMatchObject({ state: 'off', source: 'org' });
    // Enabling an unverified own credential names what is missing.
    const enable = await call(h, 'POST', `/api/v1/orgs/${org.id}/wallet-enrolments/google/enable`, {
      expectedRevision: 1,
    });
    expect(enable.status).toBe(409);
    expect(await enable.json()).toMatchObject({ code: 'WALLET_ENROLMENT_PREREQUISITE' });
  });

  it('the old account routes answer 410 for a row on the new model', async () => {
    const org = await k.org();
    const m = await k.member(org.id);
    const h = await headers(m.user.id, ['user']);
    await call(h, 'PUT', `/api/v1/orgs/${org.id}/wallet-credentials`, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google(),
    });
    await call(h, 'PUT', `/api/v1/orgs/${org.id}/wallet-enrolments/google`, {
      source: 'org',
      expectedRevision: 0,
    });
    const body = { orgId: org.id, mode: 'test', provider: 'google', expectedRevision: 0 };
    const put = await call(h, 'PUT', '/api/v1/wallet-providers/accounts', {
      ...body,
      credentials: k.google(),
    });
    expect(put.status).toBe(410);
    expect(await put.json()).toMatchObject({ code: 'WALLET_ACCOUNT_MOVED' });
    expect((await call(h, 'POST', '/api/v1/wallet-providers/accounts/revoke', body)).status).toBe(
      410,
    );
  });

  it('platform routes are for admins; a hold through the route holds', async () => {
    const org = await k.org();
    const m = await k.member(org.id);
    const memberH = await headers(m.user.id, ['user']);
    const admin = await k.admin();
    const adminH = await headers(admin.user.id, ['admin', 'user']);
    expect((await call(memberH, 'GET', '/api/v1/platform/wallet-credentials')).status).toBe(403);
    const put = await call(adminH, 'PUT', '/api/v1/platform/wallet-credentials', {
      mode: 'test',
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('444000333'),
    });
    expect(put.status).toBe(200);
    // The org picks the platform source (checks are written by the check job, so it stays Off).
    await call(memberH, 'PUT', `/api/v1/orgs/${org.id}/wallet-enrolments/google`, {
      source: 'platform',
      expectedRevision: 0,
    });
    const hold = `/api/v1/platform/orgs/${org.id}/wallet-enrolments/test/google`;
    expect((await call(memberH, 'POST', `${hold}/hold`, { reason: 'abuse' })).status).toBe(403);
    const held = await call(adminH, 'POST', `${hold}/hold`, { reason: 'abuse' });
    expect(await held.json()).toEqual({ status: 'held' });
    expect(
      await first(
        env.DB,
        'SELECT platform_hold_reason AS r FROM wallet_provider_accounts WHERE org_id = ? AND mode = ?',
        [org.id, 'test'],
      ),
    ).toEqual({ r: 'abuse' });
    const listed = await call(adminH, 'GET', '/api/v1/platform/wallet-enrolments?provider=google');
    expect(((await listed.json()) as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({
        orgId: org.id,
        mode: 'test',
        source: 'platform',
        state: 'held',
        hold: expect.objectContaining({ reason: 'abuse' }),
      }),
    );
    expect(
      (await call(memberH, 'GET', '/api/v1/platform/wallet-enrolments?provider=google')).status,
    ).toBe(403);
    expect(await (await call(adminH, 'POST', `${hold}/release`)).json()).toEqual({
      status: 'released',
    });
  });

  it('pages the platform enrolment list by keyset and hides deleted orgs', async () => {
    const admin = await k.admin();
    const adminH = await headers(admin.user.id, ['admin', 'user']);
    await call(adminH, 'PUT', '/api/v1/platform/wallet-credentials', {
      mode: 'test',
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('555000444'),
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const org = await k.org();
      const m = await k.member(org.id);
      await call(
        await headers(m.user.id, ['user']),
        'PUT',
        `/api/v1/orgs/${org.id}/wallet-enrolments/google`,
        {
          source: 'platform',
          expectedRevision: 0,
        },
      );
      ids.push(org.id);
    }
    await run(env.DB, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [ids[2] as string]);
    type Page = { items: { orgId: string; mode: string }[]; nextCursor: string | null };
    const seen: string[] = [];
    let cursor = '';
    for (let guard = 0; guard < 200; guard++) {
      const res = await call(
        adminH,
        'GET',
        `/api/v1/platform/wallet-enrolments?provider=google&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      const page = (await res.json()) as Page;
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((i) => i.orgId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toContain(ids[0]);
    expect(seen).toContain(ids[1]);
    expect(seen).not.toContain(ids[2]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(
      (await call(adminH, 'GET', '/api/v1/platform/wallet-enrolments?provider=google&cursor=%25'))
        .status,
    ).toBe(422);
  });

  it('scopes by org and mode: cross-org 404, non-member 403, Live apart from Test, suspended org 403', async () => {
    const orgA = await k.org();
    const orgB = await k.org();
    const a = await k.member(orgA.id);
    const b = await k.member(orgB.id);
    const ha = await headers(a.user.id, ['user']);
    const hb = await headers(b.user.id, ['user']);
    const body = { provider: 'google', expectedRevision: 0, credentials: k.google('600000001') };
    const theirs = (await (
      await call(hb, 'PUT', `/api/v1/orgs/${orgB.id}/wallet-credentials`, {
        ...body,
        credentials: k.google('600000002'),
      })
    ).json()) as { id: string };
    // A member of A on B's paths: not a member.
    expect((await call(ha, 'GET', `/api/v1/orgs/${orgB.id}/wallet-credentials`)).status).toBe(403);
    expect((await call(ha, 'PUT', `/api/v1/orgs/${orgB.id}/wallet-credentials`, body)).status).toBe(
      403,
    );
    // B's credential id on A's path: not A's row.
    const revoke = await call(
      ha,
      'POST',
      `/api/v1/orgs/${orgA.id}/wallet-credentials/${theirs.id}/revoke`,
      { expectedRevision: 1 },
    );
    expect(revoke.status).toBe(404);
    expect(
      await first(env.DB, 'SELECT 1 FROM wallet_credentials WHERE id = ? AND revoked_at IS NULL', [
        theirs.id,
      ]),
    ).not.toBeNull();
    // Live and Test are separate credentials of the same org.
    const live = { ...ha, 'x-passbook-mode': 'live' };
    expect((await call(ha, 'PUT', `/api/v1/orgs/${orgA.id}/wallet-credentials`, body)).status).toBe(
      200,
    );
    expect(
      (await call(live, 'PUT', `/api/v1/orgs/${orgA.id}/wallet-credentials`, body)).status,
    ).toBe(200);
    const listed = async (h: Record<string, string>) =>
      (
        (await (await call(h, 'GET', `/api/v1/orgs/${orgA.id}/wallet-credentials`)).json()) as {
          items: { mode: string }[];
        }
      ).items.map((i) => i.mode);
    expect(await listed(ha)).toEqual(['test']);
    expect(await listed(live)).toEqual(['live']);
    // A suspended org takes no write.
    await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [orgA.id]);
    expect(
      (
        await call(ha, 'PUT', `/api/v1/orgs/${orgA.id}/wallet-credentials`, {
          ...body,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(403);
  });
});
