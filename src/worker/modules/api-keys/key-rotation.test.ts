import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { createKey } from './repo-create.ts';
import type { ApiKeyRow } from './repo-row.ts';
import { create, f, h, member, org, setup, teardown } from './test-kit.ts';

beforeEach(async () => {
  await setup();
  await run(h.env.DB, 'DELETE FROM api_keys');
  await run(h.env.DB, 'DELETE FROM audit_log');
});
afterEach(teardown);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NET = '198.51.100.0/24';
const IN = '198.51.100.7';

interface Minted {
  id: string;
  secret: string;
  scopes: string[];
  retireAt: number | null;
  expiresAt: number | null;
  parentKeyId: string | null;
  rotatedFrom: string | null;
}
interface Rotated {
  key: Minted;
  previous: Minted;
}

async function mint(over: object = {}, mode: 'live' | 'test' = 'live') {
  const { session } = await member('org_admin');
  const res = await create(
    { ...session.headers, 'x-passbook-mode': mode },
    { orgId: org.id, name: 'CI', scopes: ['passes:read', 'api-keys:write'], mode, ...over },
  );
  expect(res.status).toBe(201);
  return { key: (await res.json()) as Minted, session };
}
const as = (key: { secret: string }) => ({
  authorization: `Bearer ${key.secret}`,
  'cf-connecting-ip': IN,
});
const works = async (key: { secret: string }) =>
  (await h.call(`/api/v1/passes?orgId=${org.id}`, { headers: as(key) })).status === 200;
const rotate = (headers: Record<string, string>, id: string, body: object = {}) =>
  h.call(`/api/v1/api-keys/${id}/rotate`, {
    method: 'POST',
    headers,
    json: { orgId: org.id, ...body },
  });
const row = (id: string) =>
  first<Record<string, string | number | null>>(h.env.DB, 'SELECT * FROM api_keys WHERE id = ?', [
    id,
  ]);
const count = async () => (await all(h.env.DB, 'SELECT id FROM api_keys')).length;

describe('rotation with an overlap window', () => {
  it('works at once; the old key works until the set time and not a moment after', async () => {
    const { key, session } = await mint();
    const res = await rotate(session.headers, key.id, { overlapHours: 6 });
    expect(res.status).toBe(201);
    const { key: next, previous } = (await res.json()) as Rotated;
    expect(next.secret).not.toBe(key.secret);
    expect(next.rotatedFrom).toBe(key.id);
    expect(previous.retireAt).toBe(h.clock.now() + 6 * HOUR);
    expect(await works(next)).toBe(true);
    expect(await works(key)).toBe(true);
    h.clock.advance(6 * HOUR - 1);
    expect(await works(key)).toBe(true);
    expect(await works(next)).toBe(true);
    h.clock.advance(1);
    expect(await works(key)).toBe(false);
    expect(await works(next)).toBe(true);
    expect((await row(key.id))?.retire_at).toBe(previous.retireAt);
  });

  it('retires the old key at once with no overlap, and never after its own expiry', async () => {
    const a = await mint();
    await rotate(a.session.headers, a.key.id, { overlapHours: 0 });
    expect(await works(a.key)).toBe(false);
    const end = h.clock.now() + 2 * HOUR;
    const b = await mint({ expiresAt: end });
    const res = (await (
      await rotate(b.session.headers, b.key.id, { overlapHours: 100 })
    ).json()) as Rotated;
    expect(res.previous.retireAt).toBe(end);
    expect(res.key.expiresAt).toBe(end);
    expect((await row(b.key.id))?.retire_at).toBe(end);
  });

  it('copies what the key is, makes the successor in the same batch, and audits without the secret', async () => {
    const { key, session } = await mint({
      ipAllow: [NET],
      expiresAt: h.clock.now() + 30 * DAY,
      scopes: ['passes:read', 'passes:write', 'templates:read'],
    });
    const next = ((await (await rotate(session.headers, key.id)).json()) as Rotated).key;
    const [a, b] = [await row(key.id), await row(next.id)];
    for (const column of [
      'scopes',
      'roles',
      'mode',
      'ip_allow',
      'expires_at',
      'kind',
      'org_id',
      'name',
      'restricted',
    ])
      expect(b?.[column], column).toEqual(a?.[column]);
    expect(b).toMatchObject({
      rotated_from: key.id,
      parent_key_id: null,
      last_used_at: null,
      revoked_at: null,
      retire_at: null,
    });
    expect(b?.key_hash).not.toBe(a?.key_hash);
    const audit = await all<{ action: string; target_id: string; detail: string }>(
      h.env.DB,
      "SELECT action, target_id, detail FROM audit_log WHERE action = 'api_key.rotate'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target_id).toBe(next.id);
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ from: key.id, overlapHours: 24 });
    expect(JSON.stringify(audit)).not.toContain(next.secret);
  });

  it('is refused for a key already retiring, revoked or expired, and changes nothing', async () => {
    const { key, session } = await mint({ expiresAt: h.clock.now() + DAY });
    await rotate(session.headers, key.id);
    const before = await count();
    await expectProblem(await rotate(session.headers, key.id), 409, 'API_KEY_NOT_ROTATABLE');
    const other = await mint();
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      h.clock.now(),
      other.key.id,
    ]);
    await expectProblem(
      await rotate(other.session.headers, other.key.id),
      409,
      'API_KEY_NOT_ROTATABLE',
    );
    const aging = await mint({ expiresAt: h.clock.now() + HOUR });
    h.clock.advance(2 * HOUR);
    const { session: fresh } = await member('org_admin');
    await expectProblem(await rotate(fresh.headers, aging.key.id), 409, 'API_KEY_NOT_ROTATABLE');
    expect(await count()).toBe(before + 2);
  });

  it('cannot make a secret the member could not have minted, and leaves the old key as it was', async () => {
    const { key } = await mint({ scopes: ['passes:read', 'brand:manage'] });
    const { session } = await member('integration_admin');
    await expectProblem(
      await rotate(session.headers, key.id),
      403,
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
    const author = await member('template_author');
    await expectProblem(await rotate(author.session.headers, key.id), 403, [
      'FORBIDDEN',
      'INSUFFICIENT_ROLE',
      'API_KEY_NOT_FOUND',
    ]);
    expect(await count()).toBe(1);
    expect((await row(key.id))?.retire_at).toBeNull();
  });

  it('keeps a test key to test mode', async () => {
    const { key, session } = await mint({}, 'test');
    await expectProblem(await rotate(session.headers, key.id), 403, 'API_KEY_MODE_MISMATCH');
    expect((await rotate({ ...session.headers, 'x-passbook-mode': 'test' }, key.id)).status).toBe(
      201,
    );
  });

  it('does not rotate a key into another org, or another org`s key', async () => {
    const { key } = await mint();
    const foreign = await member('org_admin');
    await expectProblem(
      await rotate(foreign.session.headers, key.id, {
        orgId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
      }),
      403,
      ['FORBIDDEN', 'NOT_A_MEMBER'],
    );
    expect(await count()).toBe(1);
  });

  it('a member rotates their own personal key, and no one else`s', async () => {
    const { session } = await member('org_admin');
    const made = await create(session.headers, {
      orgId: org.id,
      name: 'Mine',
      kind: 'personal',
      scopes: ['passes:read'],
      expiresAt: h.clock.now() + 30 * DAY,
    });
    const own = (await made.json()) as Minted;
    const peer = await member('org_admin');
    await expectProblem(await rotate(peer.session.headers, own.id), 404, 'API_KEY_NOT_FOUND');
    const res = await rotate(session.headers, own.id, { overlapHours: 1 });
    expect(res.status).toBe(201);
    const next = ((await res.json()) as Rotated).key;
    expect(await row(next.id)).toMatchObject({
      kind: 'personal',
      membership_id: (await row(own.id))?.membership_id,
    });
  });

  it('is all or nothing: a key revoked between the read and the write yields no successor', async () => {
    const { key } = await mint();
    const ctx = createServiceContext(h.env, { clock: h.clock });
    const m = await member('org_admin');
    const auth = await createSessionStore(h.env, h.clock).resolve(m.session.cookieValue);
    if (!auth) throw new Error('session fixture missing');
    const authority = await tenantAuthorityOf(ctx, auth, org.id, 'integrations:manage');
    if (authority.kind !== 'session') throw new Error('expected a member');
    const old = (await row(key.id)) as unknown as ApiKeyRow;
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [h.clock.now(), key.id]);
    const id = f().ids.id();
    await expect(
      createKey(
        ctx,
        { ...old, id, prefix: id.slice(-8), key_hash: `h${id}`, rotated_from: key.id },
        authority,
        {
          orgId: org.id,
          actorType: 'user',
          actorId: m.user.id,
          action: 'api_key.rotate',
          targetType: 'api_key',
          targetId: id,
        },
        { replaces: { id: key.id, retireAt: h.clock.now() + HOUR, parent: null, self: false } },
      ),
    ).rejects.toMatchObject({ code: 'API_KEY_NOT_FOUND' });
    expect(await row(id)).toBeNull();
  });
});

describe('a key rotates itself and its children', () => {
  it('replaces itself with the same reach, including the right to mint, and the old key retires', async () => {
    const { key } = await mint();
    const res = await h.call('/api/v1/api-keys/me/rotate', {
      method: 'POST',
      headers: as(key),
      json: { overlapHours: 2 },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { key: next, previous } = (await res.json()) as Rotated;
    expect(next.scopes).toEqual(key.scopes);
    expect(next.rotatedFrom).toBe(key.id);
    expect(previous.retireAt).toBe(h.clock.now() + 2 * HOUR);
    expect(await works(next)).toBe(true);
    const grandchild = await h.call('/api/v1/api-keys', {
      method: 'POST',
      headers: as(next),
      json: { orgId: org.id, name: 'c', scopes: ['passes:read'] },
    });
    expect(grandchild.status).toBe(201);
    h.clock.advance(2 * HOUR);
    expect(await works(key)).toBe(false);
    expect(await row(key.id)).toMatchObject({ retire_at: h.clock.now() });
  });

  it('a parent replaces its child, which keeps the parent; the child alone cannot', async () => {
    const { key: parent } = await mint();
    const made = await h.call('/api/v1/api-keys', {
      method: 'POST',
      headers: as(parent),
      json: { orgId: org.id, name: 'c', scopes: ['passes:read'] },
    });
    const kid = (await made.json()) as Minted;
    const res = await rotate(as(parent), kid.id, { overlapHours: 1 });
    expect(res.status).toBe(201);
    const next = ((await res.json()) as Rotated).key;
    expect(next).toMatchObject({
      parentKeyId: parent.id,
      rotatedFrom: kid.id,
      scopes: ['passes:read'],
    });
    const self = await h.call('/api/v1/api-keys/me/rotate', {
      method: 'POST',
      headers: as(kid),
      json: {},
    });
    await expectProblem(self, 403, 'MISSING_SCOPE');
  });

  it('a retiring parent takes its children with it, and the successor starts with none', async () => {
    const { key, session } = await mint();
    const kid = (await (
      await h.call('/api/v1/api-keys', {
        method: 'POST',
        headers: as(key),
        json: { orgId: org.id, name: 'c', scopes: ['passes:read'] },
      })
    ).json()) as Minted;
    const next = (
      (await (await rotate(session.headers, key.id, { overlapHours: 1 })).json()) as Rotated
    ).key;
    expect(await works(kid)).toBe(true);
    h.clock.advance(HOUR);
    expect(await works(kid)).toBe(false);
    expect(
      (await h
        .call(`/api/v1/api-keys?orgId=${org.id}`, { headers: as(next) })
        .then((r) => r.json())) as { items: unknown[] },
    ).toMatchObject({ items: [] });
  });
});
