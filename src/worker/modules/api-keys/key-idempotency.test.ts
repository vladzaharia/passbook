import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, run } from '../../platform/db.ts';
import { create, h, member, org, setup, teardown } from './test-kit.ts';

beforeEach(async () => {
  await setup();
  await run(h.env.DB, 'DELETE FROM api_keys');
  await run(h.env.DB, 'DELETE FROM idempotent_requests');
});
afterEach(teardown);

interface Minted {
  id: string;
  secret?: string;
}
const count = async () => (await all(h.env.DB, 'SELECT id FROM api_keys')).length;
const stored = async () =>
  JSON.stringify(await all(h.env.DB, 'SELECT body FROM idempotent_requests'));

async function parent() {
  const { session } = await member('org_admin');
  const res = await create(session.headers, {
    orgId: org.id,
    name: 'CI',
    scopes: ['passes:read', 'api-keys:write'],
  });
  return { key: (await res.json()) as Required<Minted>, session };
}
const withKey = (headers: Record<string, string>, key: string) => ({
  ...headers,
  'idempotency-key': key,
});

describe('Idempotency-Key on rotate and mint', () => {
  it('a retried rotate makes one successor, and the replay carries no secret', async () => {
    const { key, session } = await parent();
    const call = () =>
      h.call(`/api/v1/api-keys/${key.id}/rotate`, {
        method: 'POST',
        headers: withKey(session.headers, 'rot-1'),
        json: { orgId: org.id, overlapHours: 2 },
      });
    const first = await call();
    expect(first.status).toBe(201);
    const made = (await first.json()) as { key: Minted };
    expect(made.key.secret).toBeTruthy();
    const again = await call();
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    const replay = (await again.json()) as { key: Minted };
    expect(replay.key.id).toBe(made.key.id);
    expect(replay.key.secret).toBeUndefined();
    expect(await count()).toBe(2);
    expect(await stored()).not.toContain(made.key.secret);
  });

  it('a reused key with another request is refused, and another principal does not share it', async () => {
    const { key, session } = await parent();
    const rot = (headers: Record<string, string>, hours: number) =>
      h.call(`/api/v1/api-keys/${key.id}/rotate`, {
        method: 'POST',
        headers,
        json: { orgId: org.id, overlapHours: hours },
      });
    expect((await rot(withKey(session.headers, 'k'), 2)).status).toBe(201);
    await expectProblem(await rot(withKey(session.headers, 'k'), 5), 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await count()).toBe(2);
  });

  it('a retried self-rotate by a key, and a retried child mint, make one key each', async () => {
    const { key } = await parent();
    const as = withKey({ authorization: `Bearer ${key.secret}` }, 'self-1');
    const mint = () =>
      h.call('/api/v1/api-keys', {
        method: 'POST',
        headers: withKey({ authorization: `Bearer ${key.secret}` }, 'mint-1'),
        json: { orgId: org.id, name: 'Child', scopes: ['passes:read'] },
      });
    const a = (await (await mint()).json()) as Minted;
    const second = await mint();
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(((await second.json()) as Minted).id).toBe(a.id);
    expect(await count()).toBe(2);
    const self = () =>
      h.call('/api/v1/api-keys/me/rotate', {
        method: 'POST',
        headers: as,
        json: { overlapHours: 3 },
      });
    const selfFirst = await self();
    expect(selfFirst.status).toBe(201);
    const selfSecret = ((await selfFirst.json()) as { key: Minted }).key.secret;
    const replay = await self();
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await count()).toBe(3);
    expect(await stored()).not.toContain(selfSecret);
    expect(await stored()).not.toContain(a.secret);
  });

  it('without the header every call runs', async () => {
    const { key, session } = await parent();
    const rot = () =>
      h.call(`/api/v1/api-keys/${key.id}/rotate`, {
        method: 'POST',
        headers: session.headers,
        json: { orgId: org.id, overlapHours: 1 },
      });
    expect((await rot()).status).toBe(201);
    await expectProblem(await rot(), 409, 'API_KEY_NOT_ROTATABLE');
  });
});
