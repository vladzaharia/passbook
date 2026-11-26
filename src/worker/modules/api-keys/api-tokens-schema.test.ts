/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from '../../../../migrations/0142_api_tokens.sql?raw';
import { makeApiKey, makeOrg, withoutTrigger } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createApiKeyStore } from './service.ts';
import { f, h, member, org, setup, teardown } from './test-kit.ts';

beforeEach(setup);
afterEach(teardown);

const DAY = 86_400_000;
const insert = async (over: Record<string, string | number | null> = {}) => {
  const id = f().ids.id();
  const row = {
    id,
    org_id: org.id,
    name: 'k',
    prefix: id.slice(-8),
    key_hash: `hash-${id}`,
    scopes: '["passes:read"]',
    created_at: h.clock.now(),
    ...over,
  };
  const columns = Object.keys(row);
  await run(
    h.env.DB,
    `INSERT INTO api_keys (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );
  return id;
};
const kindOf = (id: string) =>
  first<{ kind: string; roles: string; retire_at: number | null; restricted: number }>(
    h.env.DB,
    'SELECT kind, roles, retire_at, restricted FROM api_keys WHERE id = ?',
    [id],
  );

describe('existing keys under migration 0142', () => {
  it('a key written with the old columns is a service key and works unchanged', async () => {
    const id = f().ids.id();
    const prefix = f().ids.token(6);
    const secret = `wlt_${prefix}_${f().ids.token()}`;
    await run(
      h.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_at)
       VALUES (?, ?, 'legacy', ?, ?, '["passes:read","templates:read"]', ?)`,
      [id, org.id, prefix, await sha256Hex(secret), h.clock.now()],
    );
    expect(await kindOf(id)).toEqual({
      kind: 'service',
      roles: '[]',
      retire_at: null,
      restricted: 0,
    });
    expect(await createApiKeyStore(h.env, h.clock).resolve(secret)).toEqual({
      kind: 'api_key',
      keyId: id,
      orgId: org.id,
      keyKind: 'service',
      scopes: ['passes:read', 'templates:read'],
      mode: 'live',
    });
    const read = await h.call('/api/v1/passes', { headers: { authorization: `Bearer ${secret}` } });
    expect(read.status).toBe(200);
    const write = await h.call('/api/v1/passes', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      json: {},
    });
    expect(write.status).toBe(403);
  });

  it('the backfill makes an org-less key a platform key and leaves org keys as service keys', async () => {
    const orgKey = await insert();
    // Before 0142 an org-less row had no kind: it is written as one, past the insert rules that came with it.
    const bare = await withoutTrigger(h.env.DB, 'api_keys_kind_rules', () =>
      insert({ org_id: null }),
    );
    await withoutTrigger(h.env.DB, 'api_keys_v2_immutable', () =>
      run(h.env.DB, "UPDATE api_keys SET kind = 'service' WHERE id = ?", [bare]),
    );
    expect((await kindOf(orgKey))?.kind).toBe('service');
    expect((await kindOf(bare))?.kind).toBe('service');
    const backfill = /UPDATE api_keys SET kind = 'platform'[^;]*;/.exec(migration)?.[0] ?? '';
    expect(backfill).not.toBe('');
    // The migration runs this before the immutability trigger exists.
    await withoutTrigger(h.env.DB, 'api_keys_v2_immutable', () => run(h.env.DB, backfill));
    expect((await kindOf(orgKey))?.kind).toBe('service');
    expect((await kindOf(bare))?.kind).toBe('platform');
  });
});

describe('api_keys_v2_immutable and REPLACE', () => {
  it('refuses a change to kind, roles, membership, restriction or allowlist', async () => {
    const id = await insert();
    const { membershipId } = await member('pass_operator');
    for (const [column, value] of [
      ['kind', 'platform'],
      ['roles', '["org_admin"]'],
      ['membership_id', membershipId],
      ['restricted', 1],
      ['ip_allow', '["0.0.0.0/0"]'],
    ] as const)
      await expect(
        run(h.env.DB, `UPDATE api_keys SET ${column} = ? WHERE id = ?`, [value, id]),
      ).rejects.toThrow('api key identity is immutable');
    expect(await kindOf(id)).toEqual({
      kind: 'service',
      roles: '[]',
      retire_at: null,
      restricted: 0,
    });
  });

  it('lets the volatile columns move: rate tier and last use', async () => {
    const id = await insert();
    await run(
      h.env.DB,
      "UPDATE api_keys SET rate_tier = 'bulk', last_ip_prefix = '203.0.113.0/24' WHERE id = ?",
      [id],
    );
    await expect(
      run(h.env.DB, "UPDATE api_keys SET rate_tier = 'unlimited' WHERE id = ?", [id]),
    ).rejects.toThrow(/CHECK/);
  });

  it('sets retire_at once, as an integer, never after expiry', async () => {
    const id = await insert({ expires_at: h.clock.now() + 10 * DAY });
    const set = (value: number | string) =>
      run(h.env.DB, 'UPDATE api_keys SET retire_at = ? WHERE id = ?', [value, id]);
    await expect(set(h.clock.now() + 11 * DAY)).rejects.toThrow('set once, before expiry');
    await expect(set('soon')).rejects.toThrow('set once, before expiry');
    await set(h.clock.now() + DAY);
    await expect(set(h.clock.now() + 2 * DAY)).rejects.toThrow('set once, before expiry');
    await expect(
      run(h.env.DB, 'UPDATE api_keys SET retire_at = NULL WHERE id = ?', [id]),
    ).rejects.toThrow('set once, before expiry');
  });

  it('INSERT OR REPLACE cannot evict a key to change its kind or roles', async () => {
    const id = await insert({ scopes: '["passes:read"]' });
    const row = await first<{ prefix: string; key_hash: string }>(
      h.env.DB,
      'SELECT prefix, key_hash FROM api_keys WHERE id = ?',
      [id],
    );
    for (const key of [{ id }, { prefix: row?.prefix }, { key_hash: row?.key_hash }])
      await expect(
        run(
          h.env.DB,
          `INSERT OR REPLACE INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_at, roles)
           VALUES (?, ?, 'x', ?, ?, '["passes:read"]', ?, '["org_admin"]')`,
          [key.id ?? 'other', org.id, key.prefix ?? 'otherpre', key.key_hash ?? 'otherhash', 1],
        ),
      ).rejects.toThrow('UNIQUE constraint failed');
    expect(await kindOf(id)).toMatchObject({ roles: '[]' });
  });
});

describe('what each kind must be when written', () => {
  it('a personal key names a live membership of its org, and an expiry within 90 days', async () => {
    const { membershipId } = await member('pass_operator');
    const personal = (over: Record<string, string | number | null> = {}) =>
      insert({
        kind: 'personal',
        membership_id: membershipId,
        expires_at: h.clock.now() + 30 * DAY,
        ...over,
      });
    await personal();
    const bad: Record<string, string | number | null>[] = [
      { membership_id: null },
      { expires_at: null },
      { expires_at: h.clock.now() + 92 * DAY },
      { org_id: (await makeOrg(f())).id },
      { membership_id: 'no-such' },
    ];
    for (const over of bad)
      await expect(personal(over)).rejects.toThrow(/does not fit its kind|FOREIGN KEY/);
    await run(h.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      h.clock.now(),
      membershipId,
    ]);
    await expect(personal()).rejects.toThrow('does not fit its kind');
    await expect(insert({ membership_id: membershipId })).rejects.toThrow('does not fit its kind');
  });

  it('a platform key has no org, an expiry within 90 days and an IP allowlist', async () => {
    const platform = (over: Record<string, string | number | null> = {}) =>
      insert({
        kind: 'platform',
        org_id: null,
        expires_at: h.clock.now() + 30 * DAY,
        ip_allow: '["203.0.113.0/24"]',
        ...over,
      });
    await platform();
    const bad: Record<string, string | number | null>[] = [
      { org_id: org.id },
      { expires_at: null },
      { expires_at: h.clock.now() + 120 * DAY },
      { ip_allow: null },
      { ip_allow: '[]' },
      { roles: '["org_admin"]' },
    ];
    // A service or personal key has an org.
    await expect(insert({ org_id: null })).rejects.toThrow('does not fit its kind');
    for (const over of bad) await expect(platform(over)).rejects.toThrow('does not fit its kind');
  });
});

describe('api_key_resources', () => {
  it('is written with a restricted key, for templates of its org, and then never changes', async () => {
    const template = async (orgId: string) => {
      const id = f().ids.id();
      await run(
        h.env.DB,
        `INSERT INTO templates (id, org_id, slug, name, origin, created_at, updated_at)
         VALUES (?, ?, ?, 'T', 'uploaded', 1, 1)`,
        [id, orgId, id],
      );
      return { id };
    };
    const tpl = await template(org.id);
    const foreign = await template((await makeOrg(f())).id);
    const id = await insert({ restricted: 1 });
    const add = (key: string, kind: string, value: string) =>
      run(h.env.DB, 'INSERT INTO api_key_resources (key_id, kind, value) VALUES (?, ?, ?)', [
        key,
        kind,
        value,
      ]);
    await add(id, 'template', tpl.id);
    await add(id, 'pass_style', 'eventTicket');
    await expect(add(id, 'template', foreign.id)).rejects.toThrow('names its templates');
    await expect(add(id, 'template', 'nope')).rejects.toThrow('names its templates');
    await expect(add(await insert(), 'pass_style', 'coupon')).rejects.toThrow(
      'names its templates',
    );
    await expect(add(id, 'colour', 'red')).rejects.toThrow(/CHECK/);
    await expect(
      run(h.env.DB, "UPDATE api_key_resources SET value = 'coupon' WHERE key_id = ?", [id]),
    ).rejects.toThrow('immutable');
    await expect(
      run(h.env.DB, 'DELETE FROM api_key_resources WHERE key_id = ?', [id]),
    ).rejects.toThrow('immutable');
    await run(h.env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', [h.clock.now(), id]);
    await expect(add(id, 'pass_style', 'coupon')).rejects.toThrow('names its templates');
    await run(h.env.DB, 'DELETE FROM api_keys WHERE id = ?', [id]);
    expect(await all(h.env.DB, 'SELECT 1 FROM api_key_resources WHERE key_id = ?', [id])).toEqual(
      [],
    );
  });
});

describe('the shared factory', () => {
  it('still writes a plain service key', async () => {
    const k = await makeApiKey(f(), { orgId: org.id });
    expect((await kindOf(k.id))?.kind).toBe('service');
  });
});
