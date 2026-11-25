import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeSession } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { systemClock } from '../../platform/clock.ts';
import { all } from '../../platform/db.ts';
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
async function headers(roles: ('admin' | 'user')[]) {
  const user = roles.includes('admin')
    ? (await k.admin()).user
    : (await k.member((await k.org()).id)).user;
  const s = await makeSession(k.f, { userId: user.id, roles });
  return { ...s.headers, 'x-passbook-mode': 'test' };
}

describe('PUT /platform/wallet-credentials/{id}/cards', () => {
  it('is for platform admins: anonymous 401, members 403', async () => {
    const path = '/api/v1/platform/wallet-credentials/x/cards';
    const body = { type: 'ticket', cardId: 'c', expectedRevision: 1 };
    expect((await call({}, 'PUT', path, body)).status).toBe(401);
    expect((await call(await headers(['user']), 'PUT', path, body)).status).toBe(403);
  });

  it('adds a card, audits it, never echoes the id, and stays append-only', async () => {
    const h = await headers(['admin', 'user']);
    const saved = await call(h, 'PUT', '/api/v1/platform/wallet-credentials', {
      provider: 'samsung',
      mode: 'test',
      expectedRevision: 0,
      credentials: k.samsung(),
    });
    // A test-mode platform credential may exist from an earlier test in the file: revoke and retry.
    let cred = (await saved.json()) as { id: string; revision: number; code?: string };
    if (saved.status !== 200) {
      const list = (await (await call(h, 'GET', '/api/v1/platform/wallet-credentials')).json()) as {
        items: {
          id: string;
          revision: number;
          provider: string;
          mode: string;
          revokedAt: number | null;
        }[];
      };
      const live = list.items.find(
        (i) => i.provider === 'samsung' && i.mode === 'test' && !i.revokedAt,
      );
      if (!live) throw new Error('no platform samsung credential');
      cred = live;
    }
    const path = `/api/v1/platform/wallet-credentials/${cred.id}/cards`;
    const put = await call(h, 'PUT', path, {
      type: 'ticket',
      cardId: 'ticketcard-secret',
      expectedRevision: cred.revision,
    });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain('ticketcard-secret');
    expect(JSON.parse(text)).toMatchObject({ cardTypes: expect.arrayContaining(['ticket']) });
    // The credential's event log is its audit trail: a rotate by the platform admin, at the new revision.
    const rows = await all<{ kind: string; actor_type: string; actor_id: string }>(
      k.env.DB,
      `SELECT kind, actor_type, actor_id FROM wallet_credential_events WHERE credential_id = ? AND revision = ?`,
      [cred.id, cred.revision + 1],
    );
    expect(rows).toEqual([
      { kind: 'rotate', actor_type: 'platform', actor_id: expect.any(String) },
    ]);
    const next = JSON.parse(text) as { revision: number };
    const other = await call(h, 'PUT', path, {
      type: 'ticket',
      cardId: 'different',
      expectedRevision: next.revision,
    });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: 'WALLET_CARD_SET' });
  });

  it('validates the body', async () => {
    const h = await headers(['admin', 'user']);
    const path = '/api/v1/platform/wallet-credentials/x/cards';
    expect(
      (await call(h, 'PUT', path, { type: 'nonsense', cardId: 'c', expectedRevision: 1 })).status,
    ).toBe(422);
    expect(
      (await call(h, 'PUT', path, { type: 'ticket', cardId: '', expectedRevision: 1 })).status,
    ).toBe(422);
    expect((await call(h, 'PUT', path, { type: 'ticket', cardId: 'c' })).status).toBe(422);
  });
});
