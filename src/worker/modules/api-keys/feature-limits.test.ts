import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { limitSuite, makeApiKey, refusedBy, setLimit } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { create, f, h, keyBody, member, org, revoke, setup, teardown } from './test-kit.ts';

let session: Record<string, string>;

beforeAll(async () => {
  await setup();
  session = (await member('org_admin')).session.headers;
});
afterAll(teardown);

/** Unrevoked, unexpired keys of the org: what the limit counts. */
const held = async () =>
  (
    await first<{ n: number }>(
      h.env.DB,
      `SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`,
      [org.id, h.clock.now()],
    )
  )?.n ?? 0;

limitSuite('API keys', async () => ({
  db: h.env.DB,
  orgId: org.id,
  key: 'api.keys',
  create: async () => refusedBy(await create(session, keyBody(org.id))),
  count: held,
}));

describe('API key limits', () => {
  it('a revoked or expired key frees its slot', async () => {
    const before = await held();
    await setLimit(h.env.DB, org.id, 'api.keys', before);
    expect((await refusedBy(await create(session, keyBody(org.id))))?.code).toBe(
      'FEATURE_LIMIT_REACHED',
    );
    await run(
      h.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, expires_at)
       VALUES ('expired-key', ?, 'Old', 'expired1', 'expired-hash', '["passes:read"]', 'live', 1, 2)`,
      [org.id],
    );
    expect(await held()).toBe(before);
    const live = await makeApiKey(f(), { orgId: org.id });
    expect(await held()).toBe(before + 1);
    expect((await revoke(session, live.id, org.id)).status).toBeLessThan(300);
    expect(await held()).toBe(before);
    await setLimit(h.env.DB, org.id, 'api.keys', before + 1);
    expect(await refusedBy(await create(session, keyBody(org.id)))).toBeNull();
  });

  it('an existing key keeps working after a downgrade below the count', async () => {
    const key = await makeApiKey(f(), { orgId: org.id, scopes: ['passes:read'] });
    await setLimit(h.env.DB, org.id, 'api.keys', 0);
    const response = await h.call('/api/v1/passes', { headers: key.headers });
    expect(response.status).toBeLessThan(400);
  });
});
