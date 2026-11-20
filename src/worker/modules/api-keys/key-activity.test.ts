import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { create, h, member, org, setup, teardown } from './test-kit.ts';

beforeEach(async () => {
  await setup();
  await run(h.env.DB, 'DELETE FROM api_keys');
  await run(h.env.DB, 'DELETE FROM audit_log');
});
afterEach(teardown);

const as = (key: { secret: string }) => ({
  authorization: `Bearer ${key.secret}`,
  'cf-connecting-ip': '198.51.100.7',
});
const get = (headers: Record<string, string>, path: string) =>
  h.call(`/api/v1/api-keys/${path}${path.includes('?') ? '&' : '?'}orgId=${org.id}`, { headers });

interface Minted {
  id: string;
  secret: string;
}
async function mint(name = 'CI') {
  const { session } = await member('org_admin');
  const res = await create(session.headers, {
    orgId: org.id,
    name,
    scopes: ['passes:read', 'api-keys:write'],
  });
  return { key: (await res.json()) as Minted, session };
}

describe('key detail', () => {
  it('names the parent, the successor and the open children, and shows the last use as a network prefix', async () => {
    const { key, session } = await mint('Deploy');
    const kid = (await (
      await h.call('/api/v1/api-keys', {
        method: 'POST',
        headers: as(key),
        json: { orgId: org.id, name: 'Job', scopes: ['passes:read'] },
      })
    ).json()) as Minted;
    await h.call(`/api/v1/passes?orgId=${org.id}`, { headers: as(kid) });
    const parent = await (await get(session.headers, key.id)).json();
    expect(parent).toMatchObject({
      id: key.id,
      name: 'Deploy',
      parent: null,
      replacedBy: null,
      childCount: 1,
    });
    const child = await (await get(session.headers, kid.id)).json();
    expect(child).toMatchObject({
      parentKeyId: key.id,
      parent: { id: key.id, name: 'Deploy' },
      lastIpPrefix: expect.any(String),
    });
    const rotated = (await (
      await h.call(`/api/v1/api-keys/${key.id}/rotate`, {
        method: 'POST',
        headers: session.headers,
        json: { orgId: org.id },
      })
    ).json()) as { key: Minted };
    expect(await (await get(session.headers, key.id)).json()).toMatchObject({
      replacedBy: { id: rotated.key.id },
    });
    const text = JSON.stringify([parent, child]);
    for (const secret of [key.secret, kid.secret]) expect(text).not.toContain(secret);
    expect(text).not.toContain('key_hash');
  });

  it('is read by members who may read keys, by a key for its children only, and by no other org', async () => {
    const { key } = await mint();
    const author = await member('template_author');
    await expectProblem(await get(author.session.headers, key.id), 403, [
      'FORBIDDEN',
      'INSUFFICIENT_ROLE',
    ]);
    const kid = (await (
      await h.call('/api/v1/api-keys', {
        method: 'POST',
        headers: as(key),
        json: { orgId: org.id, name: 'Job', scopes: ['passes:read'] },
      })
    ).json()) as Minted;
    expect((await get(as(key), kid.id)).status).toBe(200);
    await expectProblem(await get(as(key), key.id), 404, 'API_KEY_NOT_FOUND');
    const outsider = await member('org_admin');
    const elsewhere = await h.call(
      `/api/v1/api-keys/${key.id}?orgId=0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c`,
      { headers: outsider.session.headers },
    );
    expect(elsewhere.status).toBeGreaterThanOrEqual(403);
  });
});

describe('key activity', () => {
  it('summarises calls by action and lists the latest, with no body, secret or detail but the refusal code', async () => {
    const { key, session } = await mint();
    const ctx = createServiceContext(h.env, { clock: h.clock });
    const base = { actorType: 'api_key' as const, actorId: key.id, orgId: org.id };
    await recordAudit(ctx, {
      ...base,
      action: 'pass.create',
      targetType: 'pass',
      targetId: 'p1',
      ipPrefix: '198.51.100',
      detail: { holder: 'Ada Lovelace', body: 'REQUEST-BODY' },
    });
    await recordAudit(ctx, {
      ...base,
      action: 'pass.create',
      targetType: 'pass',
      targetId: 'p2',
      detail: { token: 'tok-secret' },
    });
    await recordAudit(ctx, {
      ...base,
      action: 'auth.denied',
      detail: { code: 'MISSING_SCOPE', route: '/api/v1/passes', note: 'REQUEST-BODY' },
    });
    await recordAudit(ctx, {
      actorType: 'api_key',
      actorId: 'another-key',
      orgId: org.id,
      action: 'pass.void',
    });
    const res = await get(session.headers, `${key.id}/activity`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { calls: number; denied: number; actions: { action: string; count: number }[] };
      recent: { action: string; outcome: string; code: string | null; targetId: string | null }[];
    };
    expect(body.summary).toMatchObject({
      calls: 3,
      denied: 1,
      actions: [
        { action: 'pass.create', count: 2 },
        { action: 'auth.denied', count: 1 },
      ],
    });
    expect(body.recent.map((r) => r.action)).toEqual(['auth.denied', 'pass.create', 'pass.create']);
    expect(body.recent[0]).toMatchObject({ outcome: 'denied', code: 'MISSING_SCOPE' });
    expect(body.recent[1]).toMatchObject({ outcome: 'allowed', code: null, targetId: 'p2' });
    const text = JSON.stringify(body);
    for (const leak of ['REQUEST-BODY', 'tok-secret', 'Ada Lovelace', key.secret])
      expect(text).not.toContain(leak);
  });

  it('counts only the last 30 days, and a key reads only its children`s activity', async () => {
    const { key } = await mint();
    const kid = (await (
      await h.call('/api/v1/api-keys', {
        method: 'POST',
        headers: as(key),
        json: { orgId: org.id, name: 'Job', scopes: ['passes:read'] },
      })
    ).json()) as Minted;
    const ctx = createServiceContext(h.env, { clock: h.clock });
    await recordAudit(ctx, {
      actorType: 'api_key',
      actorId: kid.id,
      orgId: org.id,
      action: 'pass.create',
    });
    h.clock.advance(31 * 86_400_000);
    const own = (await (await get(as(key), `${kid.id}/activity`)).json()) as {
      summary: { calls: number };
      recent: unknown[];
    };
    expect(own.summary.calls).toBe(0);
    expect(own.recent).toHaveLength(1);
    await expectProblem(await get(as(key), `${key.id}/activity`), 404, 'API_KEY_NOT_FOUND');
  });
});
