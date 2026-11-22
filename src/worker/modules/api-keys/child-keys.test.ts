import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  makeApiKey,
  makeTemplate,
  persistTemplate,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { keyLive } from '../../platform/repo-api-key-sql.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKey } from './service.ts';
import { create, f, h, member, org, setup, teardown } from './test-kit.ts';

beforeEach(async () => {
  await setup();
  await run(h.env.DB, 'DELETE FROM api_keys');
  await run(h.env.DB, 'DELETE FROM audit_log');
});
afterEach(teardown);

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NET = '198.51.100.0/24';
const IN = '198.51.100.7';
const PARENT = ['api-keys:write', 'passes:read', 'passes:write', 'templates:read'];

interface Minted {
  id: string;
  secret: string;
  scopes: string[];
  expiresAt: number | null;
  ipAllow: string[];
  mode: string;
  parentKeyId: string | null;
}

/** A key a member made, as a CI job would hold it. */
async function mint(over: object = {}, mode: 'live' | 'test' = 'live'): Promise<Minted> {
  const { session } = await member('org_admin');
  const res = await create(
    { ...session.headers, 'x-passbook-mode': mode },
    { orgId: org.id, name: 'CI', scopes: PARENT, mode, ...over },
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Minted;
}
const as = (key: { secret: string }, ip?: string) => ({
  authorization: `Bearer ${key.secret}`,
  ...(ip ? { 'cf-connecting-ip': ip } : {}),
});
const child = (key: { secret: string }, body: object, ip?: string) =>
  h.call('/api/v1/api-keys', {
    method: 'POST',
    headers: as(key, ip),
    json: { orgId: org.id, name: 'Child', scopes: ['passes:read'], ...body },
  });
const row = (id: string) =>
  first<Record<string, string | number | null>>(h.env.DB, 'SELECT * FROM api_keys WHERE id = ?', [
    id,
  ]);

describe('a key mints a child', () => {
  it('records the parent, works at once, and audits the key as the actor', async () => {
    const parent = await mint();
    const res = await child(parent, { scopes: ['passes:read'] });
    expect(res.status).toBe(201);
    const made = (await res.json()) as Minted;
    expect(made).toMatchObject({ parentKeyId: parent.id, scopes: ['passes:read'], mode: 'live' });
    expect(await row(made.id)).toMatchObject({ parent_key_id: parent.id, created_by: null });
    const read = await h.call(`/api/v1/passes?orgId=${org.id}`, { headers: as(made) });
    expect(read.status).toBe(200);
    const audit = await first<{ actor_type: string; actor_id: string; detail: string }>(
      h.env.DB,
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'api_key.create' AND actor_type = 'api_key'",
    );
    expect(audit).toMatchObject({ actor_type: 'api_key', actor_id: parent.id });
    expect(audit?.detail).not.toContain(made.secret);
  });

  it('refuses a scope the parent lacks, the right to mint, and a role beyond the parent', async () => {
    const parent = await mint({ scopes: ['api-keys:write', 'passes:read'] });
    for (const body of [
      { scopes: ['templates:read'] },
      { scopes: ['api-keys:write'] },
      { scopes: [], roles: ['org_admin'] },
      { scopes: [], roles: ['pass_operator'] },
    ])
      await expectProblem(await child(parent, body), 403, 'API_KEY_SCOPE_EXCEEDS_CREATOR');
    expect(await all(h.env.DB, 'SELECT id FROM api_keys WHERE parent_key_id IS NOT NULL')).toEqual(
      [],
    );
  });

  it('holds the mode: a child of a live key is live, of a test key is test, whatever the body names', async () => {
    const live = await mint();
    const test = await mint({}, 'test');
    for (const [parent, mode, asked] of [
      [live, 'live', 'test'],
      [live, 'live', 'live'],
      [test, 'test', 'live'],
      [test, 'test', 'test'],
    ] as const) {
      const res = await child(parent, { mode: asked });
      expect(res.status).toBe(201);
      expect(((await res.json()) as Minted).mode).toBe(mode);
    }
    expect(
      await all(h.env.DB, "SELECT id FROM api_keys WHERE parent_key_id = ? AND mode = 'test'", [
        live.id,
      ]),
    ).toEqual([]);
  });

  it('holds the expiry: never later than the parent, and the parent`s when none is asked', async () => {
    const end = h.clock.now() + 10 * DAY;
    const parent = await mint({ expiresAt: end });
    await expectProblem(await child(parent, { expiresAt: end + 1 }), 403, 'API_KEY_CHILD_WIDER');
    await expectProblem(await child(parent, { expiresAt: null }), 403, 'API_KEY_CHILD_WIDER');
    expect(((await (await child(parent, {})).json()) as Minted).expiresAt).toBe(end);
    expect(
      ((await (await child(parent, { expiresAt: end - DAY })).json()) as Minted).expiresAt,
    ).toBe(end - DAY);
    // A parent that never expires lets a child pick any expiry, or none.
    const open = await mint();
    expect((await child(open, { expiresAt: h.clock.now() + DAY })).status).toBe(201);
  });

  it('holds the addresses: inside the parent`s list, and the parent`s list when none is asked', async () => {
    const parent = await mint({ ipAllow: [NET] });
    for (const ipAllow of [['203.0.113.0/24'], [NET, '203.0.113.0/24'], ['198.51.100.0/23']])
      await expectProblem(await child(parent, { ipAllow }, IN), 403, 'API_KEY_CHILD_WIDER');
    const inherited = (await (await child(parent, {}, IN)).json()) as Minted;
    expect(inherited.ipAllow).toEqual([NET]);
    const narrower = (await (
      await child(parent, { ipAllow: ['198.51.100.0/25'] }, IN)
    ).json()) as Minted;
    expect(narrower.ipAllow).toEqual(['198.51.100.0/25']);
    // The child answers only from its own list.
    const call = (ip: string) =>
      h.call(`/api/v1/passes?orgId=${org.id}`, { headers: as(narrower, ip) });
    expect((await call('198.51.100.200')).status).toBe(401);
    expect((await call('198.51.100.9')).status).toBe(200);
  });

  it('cannot mint when it is itself a child, and a family never changes', async () => {
    const parent = await mint();
    const kid = (await (await child(parent, {})).json()) as Minted;
    await expectProblem(await child(kid, {}), 403, 'MISSING_SCOPE');
    // A key row that is a child and holds the right (forged past the insert rules) is refused by the service.
    const forged = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['api-keys:write', 'passes:read'],
    });
    await expect(
      run(h.env.DB, 'UPDATE api_keys SET parent_key_id = ? WHERE id = ?', [parent.id, forged.id]),
    ).rejects.toThrow(/family is immutable/);
    await withoutTrigger(h.env.DB, 'api_keys_family_immutable', () =>
      run(h.env.DB, 'UPDATE api_keys SET parent_key_id = ? WHERE id = ?', [parent.id, forged.id]),
    );
    await expectProblem(await child(forged, {}), 403, 'API_KEY_CHILD_CANNOT_MINT');
    const platform = await makeApiKey(f(), { scopes: ['api-keys:write'] });
    await expectProblem(await child(platform, {}), 403, 'FORBIDDEN');
  });
});

describe('a retiring parent', () => {
  it('mints no child: the service, the database and the grant each refuse', async () => {
    const parent = await mint();
    const { session } = await member('org_admin');
    await h.call(`/api/v1/api-keys/${parent.id}/retire`, {
      method: 'POST',
      headers: session.headers,
      json: { orgId: org.id, retireAt: h.clock.now() + DAY },
    });
    await expectProblem(await child(parent, {}), 403, 'API_KEY_PARENT_RETIRING');
    // Past the service: the insert trigger.
    await expect(
      run(
        h.env.DB,
        `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, parent_key_id)
         VALUES ('late', ?, 'c', 'late', 'hlate', '["passes:read"]', 'live', ?, 'service', ?)`,
        [org.id, h.clock.now(), parent.id],
      ),
    ).rejects.toThrow(/wider than its parent/);
    expect(await row('late')).toBeNull();
  });

  it('stops a child at the grant when the retire time passes, though the child has none of its own', async () => {
    const parent = await mint();
    const kid = (await (await child(parent, {})).json()) as Minted;
    const grantLive = async () => {
      const live = keyLive('k', h.clock.now(), true);
      return first(h.env.DB, `SELECT 1 AS ok FROM api_keys k WHERE k.id = ? AND ${live.sql}`, [
        kid.id,
        ...live.params,
      ]);
    };
    // A retire time set on the parent row alone, as a cascade that missed the child would leave it.
    await run(h.env.DB, 'UPDATE api_keys SET retire_at = ? WHERE id = ?', [
      h.clock.now() + HOUR,
      parent.id,
    ]);
    expect(await grantLive()).not.toBeNull();
    h.clock.advance(HOUR);
    expect(await grantLive()).toBeNull();
    expect((await row(kid.id))?.retire_at).toBeNull();
  });
});

describe('what a key caller is told', () => {
  it('names no member as the creator of a child, in a list or a read', async () => {
    const parent = await mint();
    const kid = (await (await child(parent, {})).json()) as Minted;
    const listed = (await (
      await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers: as(parent) })
    ).json()) as { items: { createdBy: string | null; createdByName: string | null }[] };
    const read = (await (
      await h.call(`/api/v1/api-keys/${kid.id}?orgId=${org.id}`, { headers: as(parent) })
    ).json()) as { createdBy: string | null; createdByName: string | null };
    for (const k of [...listed.items, read])
      expect(k).toMatchObject({ createdBy: null, createdByName: null });
  });
});

describe('a family is bounded', () => {
  it('holds at most 50 open children, and a revoked one frees a place', async () => {
    const parent = await mint();
    const insert = (n: number) =>
      run(
        h.env.DB,
        `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, parent_key_id)
         VALUES (?, ?, 'c', ?, ?, '["passes:read"]', 'live', ?, 'service', ?)`,
        [`kid-${n}`, org.id, `kid-${n}`, `h${n}`, h.clock.now(), parent.id],
      );
    for (let n = 0; n < 50; n++) await insert(n);
    await expectProblem(await child(parent, {}), 422, 'API_KEY_CHILD_LIMIT');
    await run(h.env.DB, "UPDATE api_keys SET revoked_at = ? WHERE id = 'kid-0'", [h.clock.now()]);
    expect((await child(parent, {})).status).toBe(201);
  });
});

describe('the database refuses a child wider than its parent', () => {
  const insert = async (parentId: string, over: Record<string, unknown>) => {
    const id = f().ids.id();
    const v = {
      org_id: org.id,
      mode: 'live',
      kind: 'service',
      scopes: '["passes:read"]',
      expires_at: null,
      ip_allow: null,
      restricted: 0,
      ...over,
    };
    return run(
      h.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, expires_at, ip_allow, restricted, parent_key_id)
       VALUES (?, ?, 'c', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        v.org_id,
        id.slice(-8),
        `h${id}`,
        v.scopes,
        v.mode,
        h.clock.now(),
        v.kind,
        v.expires_at,
        v.ip_allow,
        v.restricted,
        parentId,
      ],
    );
  };

  it('in scopes, mode, org, expiry and addresses', async () => {
    const end = h.clock.now() + DAY;
    const p = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['passes:read', 'api-keys:write'],
      expiresAt: end,
      ipAllow: [NET],
    });
    const net = { ip_allow: `["${NET}"]`, expires_at: end };
    await insert(p.id, net);
    for (const over of [
      { scopes: '["passes:write"]' },
      { scopes: '["api-keys:write"]' },
      { scopes: '["scans:write"]' },
      { mode: 'test' },
      { expires_at: end + 1 },
      { expires_at: null },
      { ip_allow: null },
      { kind: 'platform' },
    ])
      await expect(insert(p.id, { ...net, ...over }), JSON.stringify(over)).rejects.toThrow(
        /wider than its parent|does not fit/,
      );
    // A parent that is itself a child, or is revoked, parents nothing.
    const kid = await insert(p.id, net).then(() =>
      first<{ id: string }>(h.env.DB, 'SELECT id FROM api_keys WHERE parent_key_id = ? LIMIT 1', [
        p.id,
      ]),
    );
    await expect(insert(kid?.id ?? '', net)).rejects.toThrow(/wider than its parent/);
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [h.clock.now(), p.id]);
    await expect(insert(p.id, net)).rejects.toThrow(/wider than its parent/);
  });

  it('in templates and pass styles: a limited parent`s limits carry down', async () => {
    const a = makeTemplate({ id: `a-${f().ids.id()}`, orgId: org.id }).resolved;
    const b = makeTemplate({ id: `b-${f().ids.id()}`, orgId: org.id }).resolved;
    await persistTemplate(f(), a);
    await persistTemplate(f(), b);
    const p = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['passes:read', 'api-keys:write'],
      templateIds: [a.id],
      passStyles: ['generic'],
    });
    const kid = f().ids.id();
    await run(
      h.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, restricted, parent_key_id)
       VALUES (?, ?, 'c', ?, ?, '["passes:read"]', 'live', ?, 'service', 1, ?)`,
      [kid, org.id, kid.slice(-8), `h${kid}`, h.clock.now(), p.id],
    );
    const add = (kind: string, value: string) =>
      run(h.env.DB, 'INSERT INTO api_key_resources (key_id, kind, value) VALUES (?, ?, ?)', [
        kid,
        kind,
        value,
      ]);
    await expect(add('template', b.id)).rejects.toThrow(/wider than its parent/);
    await expect(add('pass_style', 'coupon')).rejects.toThrow(/wider than its parent/);
    await add('template', a.id);
    await add('pass_style', 'generic');
  });

  // The child trigger only sees resource rows as they are inserted, so a limited child that names nothing was
  // never compared with its parent. key_templates (0195) intersects the parent's limits at read time.
  it('a limited child naming nothing reaches only its limited parent`s templates', async () => {
    const a = makeTemplate({ id: `a-${f().ids.id()}`, orgId: org.id }).resolved;
    const b = makeTemplate({ id: `b-${f().ids.id()}`, orgId: org.id }).resolved;
    await persistTemplate(f(), a);
    await persistTemplate(f(), b);
    const p = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['passes:read', 'api-keys:write'],
      templateIds: [a.id],
    });
    const kid = f().ids.id();
    await run(
      h.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, restricted, parent_key_id)
       VALUES (?, ?, 'c', ?, ?, '["passes:read"]', 'live', ?, 'service', 1, ?)`,
      [kid, org.id, kid.slice(-8), `h${kid}`, h.clock.now(), p.id],
    );
    const reach = async (key: string) =>
      (
        await all<{ id: string }>(
          h.env.DB,
          'SELECT id FROM key_templates WHERE key_id = ? AND id IN (?, ?)',
          [key, a.id, b.id],
        )
      ).map((r) => r.id);
    expect(await reach(p.id)).toEqual([a.id]);
    expect(await reach(kid)).toEqual([a.id]);
  });
});

describe('a limited parent, through the service', () => {
  it('names only its own templates and styles, whatever the child asks', async () => {
    const a = makeTemplate({ id: `a-${f().ids.id()}`, orgId: org.id }).resolved;
    const b = makeTemplate({ id: `b-${f().ids.id()}`, orgId: org.id }).resolved;
    await persistTemplate(f(), a);
    await persistTemplate(f(), b);
    const p = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['passes:read', 'api-keys:write'],
      templateIds: [a.id],
      passStyles: ['generic'],
    });
    const rev = await first<{ access_revision: number }>(
      h.env.DB,
      'SELECT access_revision FROM orgs WHERE id = ?',
      [org.id],
    );
    const authority = {
      kind: 'api_key' as const,
      orgId: org.id,
      orgAccessRevision: rev?.access_revision ?? 0,
      keyId: p.id,
      keyOrgId: org.id,
      scopes: ['passes:read', 'api-keys:write'] as never,
      scope: 'api-keys:write' as const,
      mode: 'live' as const,
    };
    const ctx = createServiceContext(h.env, { clock: h.clock });
    const ask = (over: object) =>
      createApiKey(ctx, authority, { orgId: org.id, name: 'k', scopes: ['passes:read'], ...over });
    await expect(ask({ templateIds: [b.id] })).rejects.toMatchObject({
      code: 'API_KEY_CHILD_WIDER',
    });
    await expect(ask({ passStyles: ['coupon'] })).rejects.toMatchObject({
      code: 'API_KEY_CHILD_WIDER',
    });
    await ask({}).catch(() => undefined);
    const resources = await all<{ key_id: string; kind: string; value: string }>(
      h.env.DB,
      'SELECT key_id, kind, value FROM api_key_resources WHERE key_id IN (SELECT id FROM api_keys WHERE parent_key_id = ?)',
      [p.id],
    );
    // A child, if one was made, is limited to the parent's templates and styles.
    for (const r of resources) expect([a.id, 'generic']).toContain(r.value);
  });
});

describe('a child ends with its parent', () => {
  it('on revoke the child is revoked with it, in the same batch, and the audit names the count', async () => {
    const parent = await mint();
    const a = (await (await child(parent, {})).json()) as Minted;
    const b = (await (await child(parent, {})).json()) as Minted;
    const { session } = await member('org_admin');
    const res = await h.call(`/api/v1/api-keys/${parent.id}?orgId=${org.id}`, {
      method: 'DELETE',
      headers: session.headers,
    });
    expect(res.status).toBe(200);
    for (const key of [a, b]) {
      expect((await row(key.id))?.revoked_at).not.toBeNull();
      expect((await h.call(`/api/v1/passes?orgId=${org.id}`, { headers: as(key) })).status).toBe(
        401,
      );
    }
    const audit = await first<{ detail: string }>(
      h.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'api_key.revoke'",
    );
    expect(JSON.parse(audit?.detail ?? '{}')).toEqual({ children: 2 });
  });

  it('even when only the parent row changes: resolution and grants read the parent`s state', async () => {
    const parent = await mint();
    const kid = (await (await child(parent, {})).json()) as Minted;
    const ok = () => h.call(`/api/v1/passes?orgId=${org.id}`, { headers: as(kid) });
    expect((await ok()).status).toBe(200);
    const grantLive = async () => {
      const live = keyLive('k', h.clock.now(), true);
      return first(h.env.DB, `SELECT 1 AS ok FROM api_keys k WHERE k.id = ? AND ${live.sql}`, [
        kid.id,
        ...live.params,
      ]);
    };
    expect(await grantLive()).not.toBeNull();
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      h.clock.now(),
      parent.id,
    ]);
    expect((await ok()).status).toBe(401);
    expect(await grantLive()).toBeNull();
    expect((await row(kid.id))?.revoked_at).toBeNull();
  });

  it('when the parent retires or expires', async () => {
    const parent = await mint({ expiresAt: h.clock.now() + 3 * DAY });
    const kid = (await (
      await child(parent, { expiresAt: h.clock.now() + 2 * DAY })
    ).json()) as Minted;
    const kid2 = (await (await child(parent, {})).json()) as Minted;
    const ok = (k: Minted) => h.call(`/api/v1/passes?orgId=${org.id}`, { headers: as(k) });
    const { session } = await member('org_admin');
    await h.call(`/api/v1/api-keys/${parent.id}/retire`, {
      method: 'POST',
      headers: session.headers,
      json: { orgId: org.id, retireAt: h.clock.now() + DAY },
    });
    expect((await ok(kid)).status).toBe(200);
    h.clock.advance(DAY - 1);
    expect((await ok(kid)).status).toBe(200);
    h.clock.advance(1);
    expect((await ok(kid)).status).toBe(401);
    expect((await ok(kid2)).status).toBe(401);
  });
});

describe('a key reaches its own children only', () => {
  it('lists, reads, revokes and rotates its children, and no other key', async () => {
    const a = await mint();
    const b = await mint({ name: 'Other CI' });
    const mine = (await (await child(a, {})).json()) as Minted;
    const theirs = (await (await child(b, {})).json()) as Minted;
    const listed = await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers: as(a) });
    expect(((await listed.json()) as { items: { id: string }[] }).items.map((k) => k.id)).toEqual([
      mine.id,
    ]);
    const at = (path: string, init: RequestInit = {}) =>
      h.call(`${path}${path.includes('?') ? '&' : '?'}orgId=${org.id}`, {
        ...init,
        headers: as(a),
      });
    await expectProblem(await at(`/api/v1/api-keys/${theirs.id}`), 404, 'API_KEY_NOT_FOUND');
    await expectProblem(
      await at(`/api/v1/api-keys/${theirs.id}/activity`),
      404,
      'API_KEY_NOT_FOUND',
    );
    await expectProblem(
      await at(`/api/v1/api-keys/${theirs.id}`, { method: 'DELETE' }),
      404,
      'API_KEY_NOT_FOUND',
    );
    await expectProblem(
      await at(`/api/v1/api-keys/${b.id}`, { method: 'DELETE' }),
      404,
      'API_KEY_NOT_FOUND',
    );
    await expectProblem(
      await at(`/api/v1/api-keys/${a.id}`, { method: 'DELETE' }),
      404,
      'API_KEY_NOT_FOUND',
    );
    const rot = (id: string) =>
      h.call(`/api/v1/api-keys/${id}/rotate`, {
        method: 'POST',
        headers: as(a),
        json: { orgId: org.id },
      });
    await expectProblem(await rot(theirs.id), 404, 'API_KEY_NOT_FOUND');
    expect((await row(theirs.id))?.revoked_at).toBeNull();
    expect((await at(`/api/v1/api-keys/${mine.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await row(mine.id))?.revoked_at).not.toBeNull();
    expect((await row(a.id))?.revoked_at).toBeNull();
  });

  it('is refused without api-keys:write, from another org, as a platform or personal key', async () => {
    const plain = await makeApiKey(f(), {
      orgId: org.id,
      scopes: ['passes:read', 'connections:write'],
    });
    const urls: [string, string][] = [
      ['GET', `/api/v1/api-keys?orgId=${org.id}`],
      ['POST', '/api/v1/api-keys'],
    ];
    for (const [method, url] of urls)
      await expectProblem(
        await h.call(url, {
          method,
          headers: as(plain),
          json:
            method === 'POST' ? { orgId: org.id, name: 'x', scopes: ['passes:read'] } : undefined,
        }),
        403,
        'MISSING_SCOPE',
      );
    await expectProblem(
      await h.call('/api/v1/api-keys/me/rotate', { method: 'POST', headers: as(plain), json: {} }),
      403,
      'MISSING_SCOPE',
    );
    const parent = await mint();
    await expectProblem(
      await h.call(`/api/v1/api-keys?orgId=${'0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'}`, {
        headers: as(parent),
      }),
      403,
      'FORBIDDEN',
    );
    const platform = await makeApiKey(f(), { scopes: ['api-keys:write'] });
    const before = await all(h.env.DB, 'SELECT id FROM api_keys');
    for (const orgId of [org.id, null])
      expect(
        (
          await h.call('/api/v1/api-keys', {
            method: 'POST',
            headers: as(platform),
            json: { orgId, name: 'x', scopes: ['passes:read'] },
          })
        ).status,
      ).toBe(403);
    expect(await all(h.env.DB, 'SELECT id FROM api_keys')).toEqual(before);
  });
});
