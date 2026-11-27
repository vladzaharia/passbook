// Platform-keys PK-6b: what a Platform key may do on the platform wallet routes, who the audit names, and the
// routes that stay a person's (design section 2.3).
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { fakeAuth, makeApiKey, makeSession } from '../../../../test/helpers/index.ts';
import { MINTABLE_PLATFORM_SCOPES } from '../../../shared/contracts/api-keys.ts';
import { createApp } from '../../app.ts';
import { systemClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

const P = '/api/v1/platform';
const GHOST = '0190a000-0000-7000-8000-000000000000';
let k: Kit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  k = await kit();
  app = createApp({
    stores: {
      ...fakeAuth('https://wallet.test').stores,
      sessions: createSessionStore(k.env, systemClock),
      apiKeys: createApiKeyStore(k.env, systemClock),
    },
    clock: systemClock,
  });
}, 30_000);

const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
  app.request(
    `https://wallet.test${P}${path}`,
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

async function platformKey(scopes: string[]) {
  const key = await makeApiKey(k.f, {
    orgId: null,
    kind: 'platform',
    scopes,
    expiresAt: Date.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
  });
  return { id: key.id, headers: { ...key.headers, 'cf-connecting-ip': '198.51.100.7' } };
}
const save = (issuer: string, mode: 'live' | 'test' = 'test') => ({
  mode,
  provider: 'google',
  expectedRevision: 0,
  credentials: k.google(issuer),
});

describe('a Platform key with platform:wallet', () => {
  it('saves, lists and checks a credential, audited as the key, and reads the other lists', async () => {
    const key = await platformKey(['platform:wallet']);
    const put = await call(key.headers, 'PUT', '/wallet-credentials', save('555000111'));
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { id: string };
    const events = await all<{ actor_type: string; actor_id: string }>(
      k.env.DB,
      'SELECT actor_type, actor_id FROM wallet_credential_events WHERE credential_id = ?',
      [saved.id],
    );
    expect(events).toEqual([{ actor_type: 'api_key', actor_id: key.id }]);
    expect(
      await all(
        k.env.DB,
        "SELECT actor_type, actor_id FROM audit_log WHERE target_id = ? AND action = 'wallet_provider.credential_create'",
        [saved.id],
      ),
    ).toEqual([{ actor_type: 'api_key', actor_id: key.id }]);
    // The run's creator column names a user: the person who minted the key.
    const rotate = await call(key.headers, 'POST', `/wallet-credentials/${saved.id}/rotate-key`);
    expect(rotate.status).toBe(202);
    const { runId } = (await rotate.json()) as { runId: string };
    expect(
      await all(
        k.env.DB,
        "SELECT actor_type, actor_id FROM audit_log WHERE target_id = ? AND action = 'wallet.google_key_rotation_requested'",
        [saved.id],
      ),
    ).toEqual([{ actor_type: 'api_key', actor_id: key.id }]);
    const row = (
      await all<{ creator: string; minter: string }>(
        k.env.DB,
        'SELECT r.created_by AS creator, a.created_by AS minter FROM identity_runs r, api_keys a WHERE r.id = ? AND a.id = ?',
        [runId, key.id],
      )
    )[0];
    expect(row?.creator).toBe(row?.minter);
    const list = await call(key.headers, 'GET', '/wallet-credentials');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(
      saved.id,
    );
    const queued = await call(key.headers, 'POST', `/wallet-credentials/${saved.id}/check`);
    expect(queued.status).toBe(200);
    const { checkId } = (await queued.json()) as { checkId: string };
    const result = await call(
      key.headers,
      'GET',
      `/wallet-credentials/${saved.id}/checks/${checkId}`,
    );
    expect(await result.json()).toMatchObject({ checkId, status: 'pending' });
    expect((await call(key.headers, 'GET', '/wallet-enrolments?provider=google')).status).toBe(200);
    expect((await call(key.headers, 'GET', '/wallet-credentials/migrate')).status).toBe(200);
    expect((await call(key.headers, 'POST', '/wallet-credentials/migrate')).status).toBe(200);
  });

  it('reaches the handler on the rest: an unknown credential or organization is refused by the service', async () => {
    const key = await platformKey(['platform:wallet']);
    for (const [method, path, body, status] of [
      ['POST', `/wallet-credentials/${GHOST}/rotate-key`, undefined, 404],
      [
        'PUT',
        `/wallet-credentials/${GHOST}/cards`,
        { type: 'loyalty', cardId: 'c1', expectedRevision: 1 },
        404,
      ],
      ['POST', `/orgs/${GHOST}/wallet-accounts/google/managed`, { mode: 'live' }, 404],
      [
        'POST',
        `/orgs/${GHOST}/wallet-accounts/google/managed/complete`,
        { issuerId: '3388000000012345678' },
        409,
      ],
    ] as const) {
      const res = await call(key.headers, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(status);
    }
  });

  it('refuses a key that holds the scope on a route kept for a person', async () => {
    const key = await platformKey([...MINTABLE_PLATFORM_SCOPES]);
    const org = await k.org();
    const person: [string, string, unknown?][] = [
      ['POST', `/wallet-credentials/${GHOST}/revoke`, { expectedRevision: 1 }],
      ['POST', `/orgs/${org.id}/wallet-enrolments/test/google/hold`, { reason: 'abuse' }],
      ['POST', `/orgs/${org.id}/wallet-enrolments/test/google/release`],
      ['POST', '/wallet-credentials/migrate/resolve', {}],
    ];
    for (const [method, path, body] of person)
      await expectProblem(await call(key.headers, method, path, body), 403, 'PERSON_REQUIRED');
  });
});

describe('the rebuilt credential event table', () => {
  it('stays append-only after the key actor type was added', async () => {
    const id = (
      await all<{ credential_id: string }>(
        k.env.DB,
        "SELECT credential_id FROM wallet_credential_events WHERE actor_type = 'api_key' LIMIT 1",
      )
    )[0]?.credential_id;
    expect(id).toBeDefined();
    await expect(
      run(k.env.DB, 'UPDATE wallet_credential_events SET request_id = ? WHERE credential_id = ?', [
        'x',
        id,
      ]),
    ).rejects.toThrow(/immutable wallet credential event/);
    await expect(
      run(k.env.DB, 'DELETE FROM wallet_credential_events WHERE credential_id = ?', [id]),
    ).rejects.toThrow(/immutable wallet credential event/);
  });
});

describe('a Platform key without the scope, and an org key', () => {
  it('reads with platform:read and is refused a write', async () => {
    const reader = await platformKey(['platform:read']);
    expect((await call(reader.headers, 'GET', '/wallet-credentials')).status).toBe(200);
    expect((await call(reader.headers, 'GET', '/wallet-enrolments?provider=google')).status).toBe(
      200,
    );
    for (const [method, path, body] of [
      ['PUT', '/wallet-credentials', save('555000333')],
      ['POST', `/wallet-credentials/${GHOST}/check`, undefined],
      ['POST', `/wallet-credentials/${GHOST}/rotate-key`, undefined],
      ['POST', '/wallet-credentials/migrate', undefined],
      ['POST', `/orgs/${GHOST}/wallet-accounts/google/managed`, { mode: 'live' }],
    ] as const)
      await expectProblem(await call(reader.headers, method, path, body), 403, 'MISSING_SCOPE');
  });

  it('refuses a key of another scope', async () => {
    const other = await platformKey(['platform:groups']);
    await expectProblem(
      await call(other.headers, 'GET', '/wallet-credentials'),
      403,
      'MISSING_SCOPE',
    );
    await expectProblem(
      await call(other.headers, 'GET', '/wallet-enrolments?provider=google'),
      403,
      'MISSING_SCOPE',
    );
  });

  it('refuses an org key', async () => {
    const org = await k.org();
    const orgKey = await makeApiKey(k.f, { orgId: org.id, scopes: ['passes:read'] });
    await expectProblem(
      await call(orgKey.headers, 'GET', '/wallet-credentials'),
      403,
      'PLATFORM_KEY_REQUIRED',
    );
    await expectProblem(
      await call(orgKey.headers, 'PUT', '/wallet-credentials', save('555000444')),
      403,
      'PLATFORM_KEY_REQUIRED',
    );
  });
});

describe('a person on the platform wallet routes', () => {
  it('still lists, saves and checks; a member is refused', async () => {
    const admin = await k.admin();
    const s = await makeSession(k.f, { userId: admin.user.id, roles: ['admin', 'user'] });
    const h = { ...s.headers, 'x-passbook-mode': 'test' };
    const put = await call(h, 'PUT', '/wallet-credentials', save('555000555', 'live'));
    expect(put.status).toBe(200);
    expect((await call(h, 'GET', '/wallet-credentials')).status).toBe(200);
    const member = await makeSession(k.f, { userId: (await k.member((await k.org()).id)).user.id });
    await expectProblem(await call(member.headers, 'GET', '/wallet-credentials'), 403, 'FORBIDDEN');
  });
});
