import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { ApiKeyListSchema, CreatedApiKeySchema } from '../../../shared/contracts/api-keys.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { fakeLimiter, harness, type TestHarness } from '../auth/test-support.ts';
import { createApiKeyStore } from './service.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);

beforeEach(async () => {
  h = await harness();
  // Storage lasts for the whole file; these tests assert on platform-wide key lists and audit rows.
  await run(h.env.DB, 'DELETE FROM api_keys');
  await run(h.env.DB, 'DELETE FROM audit_log');
});
afterEach(() => h.restore());

async function grantOrgRole(userId: string, orgId: string, role: OrgRole) {
  const fx = f();
  const invitationId = fx.ids.id();
  const now = h.clock.now();
  const roles = JSON.stringify([role]);
  await run(
    h.env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, roles, fx.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    h.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [fx.ids.id(), orgId, userId, invitationId, roles, now],
  );
}

async function adminHeaders(orgId?: string) {
  const user = await makeUser(f());
  if (orgId) await grantOrgRole(user.id, orgId, 'org_admin');
  const s = await makeSession(f(), { userId: user.id, roles: ['admin', 'user'] });
  return { headers: s.headers, userId: user.id };
}

async function memberHeaders(orgId: string, role: OrgRole, platformAdmin = false) {
  const user = await makeUser(f());
  await grantOrgRole(user.id, orgId, role);
  const s = await makeSession(f(), {
    userId: user.id,
    roles: platformAdmin ? ['admin', 'user'] : ['user'],
  });
  return { headers: s.headers, userId: user.id };
}

interface Created {
  id: string;
  secret: string;
  prefix: string;
  scopes: string[];
  mode?: string;
  orgId: string | null;
  createdBy: string;
}

async function create(body: object, orgId?: string) {
  const { headers: base, userId } = await adminHeaders(orgId);
  // A tenant key takes the session's mode, so a test-mode key needs a test-mode session.
  const headers =
    orgId && (body as { mode?: string }).mode === 'test'
      ? { ...base, 'x-passbook-mode': 'test' }
      : base;
  const res = await h.call('/api/v1/api-keys', { method: 'POST', json: body, headers });
  return { res, headers, userId, key: (await res.clone().json()) as Created };
}

describe('credential identity invariant', () => {
  it('rejects in-place identity and authority changes while a new key resolves independently', async () => {
    const org = await makeOrg(f());
    const otherOrg = await makeOrg(f());
    const { res, key } = await create(
      { name: 'original', scopes: ['passes:read'], orgId: org.id },
      org.id,
    );
    expect(res.status).toBe(201);
    const mutations: [string, string | number | null][] = [
      ['id', 'replacement-id'],
      ['org_id', otherOrg.id],
      ['org_id', null],
      ['name', 'replacement'],
      ['prefix', 'replacement-prefix'],
      ['key_hash', 'replacement-hash'],
      ['scopes', '["passes:write"]'],
      ['mode', 'test'],
      ['created_by', null],
      ['created_at', 1],
      ['expires_at', h.clock.now() + 60_000],
    ];
    for (const [column, value] of mutations) {
      await expect(
        run(h.env.DB, `UPDATE api_keys SET ${column} = ? WHERE id = ?`, [value, key.id]),
      ).rejects.toThrow('api key identity is immutable');
    }
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(key.secret)).toMatchObject({
      keyId: key.id,
      orgId: org.id,
      scopes: ['passes:read'],
      mode: 'live',
    });
    const replacement = await create(
      { name: 'replacement', scopes: ['passes:write'], mode: 'test', orgId: org.id },
      org.id,
    );
    expect(replacement.res.status).toBe(201);
    expect(replacement.key.id).not.toBe(key.id);
    expect(await store.resolve(replacement.key.secret)).toMatchObject({
      keyId: replacement.key.id,
      orgId: org.id,
      scopes: ['passes:write'],
      mode: 'test',
    });
  });

  it('preserves a key and its scope when its creator is deleted without allowing reassignment', async () => {
    const org = await makeOrg(f());
    const { res, key, userId } = await create(
      { name: 'creator deletion', scopes: ['passes:read'], orgId: org.id },
      org.id,
    );
    expect(res.status).toBe(201);
    const otherUser = await makeUser(f());
    await expect(
      run(h.env.DB, 'UPDATE api_keys SET created_by = ? WHERE id = ?', [otherUser.id, key.id]),
    ).rejects.toThrow('api key identity is immutable');
    // Memberships are permanent and block user deletion; model a creator who never joined the org.
    await withoutTrigger(h.env.DB, 'org_memberships_no_delete', () =>
      run(h.env.DB, 'DELETE FROM org_memberships WHERE user_id = ?', [userId]),
    );
    await run(h.env.DB, 'DELETE FROM users WHERE id = ?', [userId]);
    expect(
      await first(h.env.DB, 'SELECT created_by, scopes FROM api_keys WHERE id = ?', [key.id]),
    ).toMatchObject({ created_by: null, scopes: '["passes:read"]' });
    expect(await createApiKeyStore(h.env, h.clock).resolve(key.secret)).toMatchObject({
      keyId: key.id,
      orgId: org.id,
      scopes: ['passes:read'],
    });
    await expect(
      run(h.env.DB, 'UPDATE api_keys SET created_by = ? WHERE id = ?', [otherUser.id, key.id]),
    ).rejects.toThrow('api key identity is immutable');
  });

  it('allows monotonic touches and irreversible revocation, and permits org cascade deletion', async () => {
    const org = await makeOrg(f());
    const { key } = await create({ name: 'key', scopes: ['passes:read'], orgId: org.id }, org.id);
    const now = h.clock.now();
    await run(h.env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, key.id]);
    await run(h.env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, key.id]);
    await run(h.env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now + 1, key.id]);
    for (const value of [now, null]) {
      await expect(
        run(h.env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', [value, key.id]),
      ).rejects.toThrow('api key last use must be monotonic');
    }
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [now, key.id]);
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [now, key.id]);
    for (const value of [null, now + 1]) {
      await expect(
        run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [value, key.id]),
      ).rejects.toThrow('api key revocation is irreversible');
    }
    expect(await createApiKeyStore(h.env, h.clock).resolve(key.secret)).toBeNull();
    const cascadeOrg = await makeOrg(f());
    const cascadeKey = await makeApiKey(f(), { orgId: cascadeOrg.id });
    await run(h.env.DB, 'DELETE FROM orgs WHERE id = ?', [cascadeOrg.id]);
    expect(
      await first(h.env.DB, 'SELECT id FROM api_keys WHERE id = ?', [cascadeKey.id]),
    ).toBeNull();
  });
});

describe('create', () => {
  it('commits the key and its audit row together', async () => {
    await run(
      h.env.DB,
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    try {
      const { res } = await create({ name: 'Atomic', scopes: ['passes:read'], orgId: null });
      expect(res.status).toBe(500);
      expect(await first(h.env.DB, "SELECT 1 AS x FROM api_keys WHERE name = 'Atomic'")).toBeNull();
    } finally {
      await run(h.env.DB, 'DROP TRIGGER fail_audit');
    }
  });

  it('returns the secret once and stores only a hash', async () => {
    const { res, key, userId } = await create({ name: 'CI', scopes: ['passes:read'], orgId: null });
    expect(res.status).toBe(201);
    expect(key.secret).toMatch(/^wlt_[\w-]{8}_[\w-]{43}$/);
    expect(key.secret.startsWith(`wlt_${key.prefix}_`)).toBe(true);
    expect(key.createdBy).toBe(userId);
    expect(key.orgId).toBeNull();
    const row = await first<{ key_hash: string; org_id: string | null }>(
      h.env.DB,
      'SELECT key_hash, org_id FROM api_keys WHERE id = ?',
      [key.id],
    );
    expect(row?.key_hash).toBe(await sha256Hex(key.secret));
    expect(row?.org_id).toBeNull();
    const { headers } = await adminHeaders();
    const listed = (await (await h.call('/api/v1/api-keys?orgId=null', { headers })).json()) as {
      items: Record<string, unknown>[];
    };
    const item = listed.items.find((i) => i.id === key.id);
    expect(item).toBeTruthy();
    // makeUser sets no name, so the chip shows the creator's email.
    expect(item?.createdByName).toBe(`${userId}@example.com`);
    expect(JSON.stringify(listed)).not.toContain(key.secret);
  });

  it('audits creation without the secret', async () => {
    const { key } = await create({ name: 'Audit', scopes: ['passes:read'], orgId: null });
    const audit = await first<{ detail: string }>(
      h.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'api_key.create' AND target_id = ?",
      [key.id],
    );
    expect(audit?.detail).not.toContain(key.secret);
  });

  it('rejects unknown scopes, empty scope lists and past expiry', async () => {
    expect((await create({ name: 'x', scopes: ['admin:all'], orgId: null })).res.status).toBe(422);
    expect((await create({ name: 'x', scopes: [], orgId: null })).res.status).toBe(422);
    const past = await create({ name: 'x', scopes: ['passes:read'], expiresAt: 1, orgId: null });
    expect(past.res.status).toBe(422);
  });

  it('scopes a key to an org only when the actor has an explicit membership', async () => {
    const org = await makeOrg(f());
    const ok = await create({ name: 'o', scopes: ['passes:read'], orgId: org.id }, org.id);
    expect(ok.res.status).toBe(201);
    expect(ok.key.orgId).toBe(org.id);
    const missing = await create({ name: 'o', scopes: ['passes:read'], orgId: 'nope' });
    expect(missing.res.status).toBe(403);
  });

  it('requires a session, an applicable privilege and CSRF', async () => {
    const user = await makeUser(f());
    const s = await makeSession(f(), { userId: user.id, roles: ['user'] });
    const body = { name: 'x', scopes: ['passes:read'], orgId: null };
    expect(
      (await h.call('/api/v1/api-keys', { method: 'POST', json: body, headers: s.headers })).status,
    ).toBe(403);
    const { headers } = await adminHeaders();
    const noCsrf = { cookie: headers.cookie ?? '' };
    expect(
      (await h.call('/api/v1/api-keys', { method: 'POST', json: body, headers: noCsrf })).status,
    ).toBe(403);
    const key = await makeApiKey(f(), { scopes: ['passes:read'] });
    expect(
      (await h.call('/api/v1/api-keys', { method: 'POST', json: body, headers: key.headers }))
        .status,
    ).toBe(401);
  });
});

describe('explicit management scope', () => {
  it('rejects missing or empty scope without creating, revoking or auditing a key', async () => {
    const org = await makeOrg(f());
    const target = await makeApiKey(f(), { orgId: org.id });
    const { headers } = await adminHeaders(org.id);
    const body = { name: 'No scope', scopes: ['passes:read'] };

    expect((await h.call('/api/v1/api-keys', { headers })).status).toBe(400);
    expect((await h.call('/api/v1/api-keys?state=live', { headers })).status).toBe(400);
    expect(
      (await h.call(`/api/v1/api-keys/${target.id}`, { method: 'DELETE', headers })).status,
    ).toBe(400);
    expect((await h.call('/api/v1/api-keys', { method: 'POST', headers, json: body })).status).toBe(
      400,
    );

    expect((await h.call('/api/v1/api-keys?orgId=', { headers })).status).toBe(422);
    expect(
      (await h.call(`/api/v1/api-keys/${target.id}?orgId=`, { method: 'DELETE', headers })).status,
    ).toBe(422);
    expect(
      (await h.call('/api/v1/api-keys', { method: 'POST', headers, json: { ...body, orgId: '' } }))
        .status,
    ).toBe(422);
    expect(
      (
        await h.call('/api/v1/api-keys', {
          method: 'POST',
          headers,
          json: { ...body, orgId: 'null' },
        })
      ).status,
    ).toBe(403);

    expect(
      await first(h.env.DB, 'SELECT revoked_at FROM api_keys WHERE id = ?', [target.id]),
    ).toEqual({ revoked_at: null });
    expect(await first(h.env.DB, "SELECT id FROM api_keys WHERE name = 'No scope'")).toBeNull();
    expect(
      await first(
        h.env.DB,
        "SELECT id FROM audit_log WHERE action IN ('api_key.create', 'api_key.revoke')",
      ),
    ).toBeNull();
  });

  it('isolates explicit platform and tenant lists and revocations', async () => {
    const org = await makeOrg(f());
    const platformKey = await makeApiKey(f(), { name: 'platform' });
    const tenantKey = await makeApiKey(f(), { orgId: org.id, name: 'tenant' });
    const { headers } = await adminHeaders(org.id);
    const readIds = async (scope: string) => {
      const res = await h.call(`/api/v1/api-keys?orgId=${scope}`, { headers });
      expect(res.status).toBe(200);
      const page = ApiKeyListSchema.parse(await res.json());
      return page.items.map((item) => item.id);
    };

    expect(await readIds('null')).toEqual([platformKey.id]);
    expect(await readIds(org.id)).toEqual([tenantKey.id]);
    expect(
      (
        await h.call(`/api/v1/api-keys/${tenantKey.id}?orgId=null`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.call(`/api/v1/api-keys/${platformKey.id}?orgId=${org.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(404);
    for (const id of [platformKey.id, tenantKey.id]) {
      expect(await first(h.env.DB, 'SELECT revoked_at FROM api_keys WHERE id = ?', [id])).toEqual({
        revoked_at: null,
      });
      expect(
        await first(
          h.env.DB,
          "SELECT id FROM audit_log WHERE action = 'api_key.revoke' AND target_id = ?",
          [id],
        ),
      ).toBeNull();
    }

    expect(
      (
        await h.call(`/api/v1/api-keys/${platformKey.id}?orgId=null`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.call(`/api/v1/api-keys/${tenantKey.id}?orgId=${org.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(200);
    expect(
      await first(h.env.DB, 'SELECT org_id, revoked_at FROM api_keys WHERE id = ?', [
        platformKey.id,
      ]),
    ).toEqual({ org_id: null, revoked_at: h.clock.now() });
    expect(
      await first(h.env.DB, 'SELECT org_id, revoked_at FROM api_keys WHERE id = ?', [tenantKey.id]),
    ).toEqual({ org_id: org.id, revoked_at: h.clock.now() });
  });

  it('denies a platform admin access to a tenant without membership', async () => {
    const org = await makeOrg(f());
    const target = await makeApiKey(f(), { orgId: org.id });
    const { headers } = await adminHeaders();
    const body = { name: 'Unauthorized tenant', scopes: ['passes:read'], orgId: org.id };

    expect((await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers })).status).toBe(403);
    expect((await h.call('/api/v1/api-keys', { method: 'POST', headers, json: body })).status).toBe(
      403,
    );
    expect(
      (
        await h.call(`/api/v1/api-keys/${target.id}?orgId=${org.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(403);
    expect(
      await first(h.env.DB, 'SELECT revoked_at FROM api_keys WHERE id = ?', [target.id]),
    ).toEqual({ revoked_at: null });
    expect(
      await first(h.env.DB, "SELECT id FROM api_keys WHERE name = 'Unauthorized tenant'"),
    ).toBeNull();
    expect(
      await first(
        h.env.DB,
        "SELECT id FROM audit_log WHERE action IN ('api_key.create', 'api_key.revoke')",
      ),
    ).toBeNull();
  });

  it('allows an integration admin only in their tenant and audits scoped mutations', async () => {
    const org = await makeOrg(f());
    const other = await makeOrg(f());
    const otherKey = await makeApiKey(f(), { orgId: other.id });
    const platformKey = await makeApiKey(f());
    const { headers, userId } = await memberHeaders(org.id, 'integration_admin');
    // An integration admin may delegate only the scopes its role grants.
    const body = { name: 'Integration key', scopes: ['connections:read'], orgId: org.id };

    for (const [scope, id] of [
      [other.id, otherKey.id],
      ['null', platformKey.id],
    ] as const) {
      expect((await h.call(`/api/v1/api-keys?orgId=${scope}`, { headers })).status).toBe(403);
      expect(
        (await h.call(`/api/v1/api-keys/${id}?orgId=${scope}`, { method: 'DELETE', headers }))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await h.call('/api/v1/api-keys', {
          method: 'POST',
          headers,
          json: { ...body, orgId: other.id },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call('/api/v1/api-keys', {
          method: 'POST',
          headers,
          json: { ...body, orgId: null },
        })
      ).status,
    ).toBe(403);
    for (const id of [otherKey.id, platformKey.id]) {
      expect(
        (await h.call(`/api/v1/api-keys/${id}?orgId=${org.id}`, { method: 'DELETE', headers }))
          .status,
      ).toBe(404);
      expect(await first(h.env.DB, 'SELECT revoked_at FROM api_keys WHERE id = ?', [id])).toEqual({
        revoked_at: null,
      });
    }
    expect(
      await first(
        h.env.DB,
        "SELECT id FROM audit_log WHERE action IN ('api_key.create', 'api_key.revoke')",
      ),
    ).toBeNull();

    const created = await h.call('/api/v1/api-keys', { method: 'POST', headers, json: body });
    expect(created.status).toBe(201);
    const key = CreatedApiKeySchema.parse(await created.json());
    expect(key).toMatchObject({ orgId: org.id, createdBy: userId });
    expect(
      await first(h.env.DB, 'SELECT org_id, created_by FROM api_keys WHERE id = ?', [key.id]),
    ).toEqual({ org_id: org.id, created_by: userId });
    const listed = await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers });
    expect(listed.status).toBe(200);
    const page = ApiKeyListSchema.parse(await listed.json());
    expect(page.items.map((item) => item.id)).toEqual([key.id]);
    expect(
      (await h.call(`/api/v1/api-keys/${key.id}?orgId=${org.id}`, { method: 'DELETE', headers }))
        .status,
    ).toBe(200);
    expect(await first(h.env.DB, 'SELECT revoked_at FROM api_keys WHERE id = ?', [key.id])).toEqual(
      {
        revoked_at: h.clock.now(),
      },
    );
    for (const action of ['api_key.create', 'api_key.revoke']) {
      expect(
        await first(
          h.env.DB,
          'SELECT org_id, actor_id FROM audit_log WHERE action = ? AND target_id = ?',
          [action, key.id],
        ),
      ).toEqual({ org_id: org.id, actor_id: userId });
    }
  });

  it('enforces tenant read and manage capabilities even for platform admins', async () => {
    const org = await makeOrg(f());
    const target = await makeApiKey(f(), { orgId: org.id });
    const body = { name: 'Read only', scopes: ['passes:read'], orgId: org.id };
    for (const platformAdmin of [false, true]) {
      const reader = await memberHeaders(org.id, 'read_only', platformAdmin);
      expect(
        (await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers: reader.headers })).status,
      ).toBe(200);
      expect(
        (
          await h.call('/api/v1/api-keys', {
            method: 'POST',
            headers: reader.headers,
            json: body,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await h.call(`/api/v1/api-keys/${target.id}?orgId=${org.id}`, {
            method: 'DELETE',
            headers: reader.headers,
          })
        ).status,
      ).toBe(403);
    }
    const author = await memberHeaders(org.id, 'template_author', true);
    expect(
      (await h.call(`/api/v1/api-keys?orgId=${org.id}`, { headers: author.headers })).status,
    ).toBe(403);
    expect(
      await first(h.env.DB, 'SELECT revoked_at FROM api_keys WHERE id = ?', [target.id]),
    ).toEqual({ revoked_at: null });
    expect(await first(h.env.DB, "SELECT id FROM api_keys WHERE name = 'Read only'")).toBeNull();
    expect(
      await first(
        h.env.DB,
        "SELECT id FROM audit_log WHERE action IN ('api_key.create', 'api_key.revoke')",
      ),
    ).toBeNull();
  });

  it('rejects platform and tenant API keys for every management operation', async () => {
    const org = await makeOrg(f());
    const scopes = ['connections:read', 'connections:write'];
    const platformKey = await makeApiKey(f(), { scopes });
    const tenantKey = await makeApiKey(f(), { orgId: org.id, scopes });
    for (const [scope, key] of [
      ['null', platformKey],
      [org.id, tenantKey],
    ] as const) {
      expect(
        (await h.call(`/api/v1/api-keys?orgId=${scope}`, { headers: key.headers })).status,
      ).toBe(401);
      expect(
        (
          await h.call('/api/v1/api-keys', {
            method: 'POST',
            headers: key.headers,
            json: {
              name: 'Bearer attempt',
              scopes: ['passes:read'],
              orgId: scope === 'null' ? null : scope,
            },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await h.call(`/api/v1/api-keys/${key.id}?orgId=${scope}`, {
            method: 'DELETE',
            headers: key.headers,
          })
        ).status,
      ).toBe(401);
      expect(
        await first(h.env.DB, 'SELECT revoked_at FROM api_keys WHERE id = ?', [key.id]),
      ).toEqual({ revoked_at: null });
    }
    expect(
      await first(h.env.DB, "SELECT id FROM api_keys WHERE name = 'Bearer attempt'"),
    ).toBeNull();
    expect(
      await first(
        h.env.DB,
        "SELECT id FROM audit_log WHERE action IN ('api_key.create', 'api_key.revoke')",
      ),
    ).toBeNull();
  });
});

describe('list', () => {
  interface Page {
    items: { id: string; name: string; orgId: string | null; revokedAt: number | null }[];
    nextCursor: string | null;
    revokedCount: number;
  }
  const list = async (headers: Record<string, string>, query: string) =>
    (await (await h.call(`/api/v1/api-keys?${query}`, { headers })).json()) as Page;

  it('pages newest first by cursor and filters by org and state', async () => {
    const org = await makeOrg(f());
    const other = await makeOrg(f());
    const made: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      h.clock.advance(1000);
      made.push((await makeApiKey(f(), { orgId: org.id, name })).id);
    }
    h.clock.advance(1000);
    await makeApiKey(f(), { orgId: other.id, name: 'elsewhere' });
    await makeApiKey(f(), { name: 'platform' });
    await run(h.env.DB, 'UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [made[0]]);
    const { headers } = await adminHeaders(org.id);

    const one = await list(headers, `orgId=${org.id}&state=live&limit=1`);
    expect(one.items.map((k) => k.name)).toEqual(['c']);
    expect(one.revokedCount).toBe(1);
    const two = await list(headers, `orgId=${org.id}&state=live&limit=1&cursor=${one.nextCursor}`);
    expect(two.items.map((k) => k.name)).toEqual(['b']);
    expect(two.nextCursor).toBeNull();

    const revoked = await list(headers, `orgId=${org.id}&state=revoked`);
    expect(revoked.items.map((k) => k.name)).toEqual(['a']);
    expect(revoked.nextCursor).toBeNull();

    // An explicitly selected platform list contains platform keys only.
    const platform = await list(headers, 'orgId=null&limit=200');
    expect(platform.items.map((k) => k.name)).toEqual(['platform']);
    expect(platform.revokedCount).toBe(0);
  });
});

describe('use', () => {
  const probe = (headers: Record<string, string>, method = 'GET') =>
    h.call('/api/v1/passes', { method, headers }).then((r) => r.status);

  it('authenticates a created key and enforces scopes', async () => {
    const { key } = await create({ name: 'reader', scopes: ['passes:read'], orgId: null });
    const headers = { authorization: `Bearer ${key.secret}` };
    expect([401, 403, 429]).not.toContain(await probe(headers));
    const write = await h.call('/api/v1/passes', {
      method: 'POST',
      headers,
      json: {},
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe('MISSING_SCOPE');
    const tmpl = await h.call('/api/v1/templates', { headers });
    expect(tmpl.status).toBe(403);
  });

  it('rejects malformed, wrong and revoked keys', async () => {
    const { key, headers: admin } = await create({
      name: 'k',
      scopes: ['passes:read'],
      orgId: null,
    });
    const bearer = (s: string) => ({ authorization: `Bearer ${s}` });
    expect(await probe(bearer('garbage'))).toBe(401);
    const tampered = `${key.secret.slice(0, -1)}${key.secret.endsWith('A') ? 'B' : 'A'}`;
    expect(await probe(bearer(tampered))).toBe(401);
    const revoke = await h.call(`/api/v1/api-keys/${key.id}?orgId=null`, {
      method: 'DELETE',
      headers: admin,
    });
    expect(revoke.status).toBe(200);
    expect(await probe(bearer(key.secret))).toBe(401);
    expect(
      (await h.call(`/api/v1/api-keys/${key.id}?orgId=null`, { method: 'DELETE', headers: admin }))
        .status,
    ).toBe(200);
    expect(
      (await h.call('/api/v1/api-keys/nope?orgId=null', { method: 'DELETE', headers: admin }))
        .status,
    ).toBe(404);
  });

  it('rejects expired keys', async () => {
    const { key } = await create({
      name: 'short',
      scopes: ['passes:read'],
      expiresAt: h.clock.now() + 60_000,
      orgId: null,
    });
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(key.secret)).not.toBeNull();
    h.clock.advance(61_000);
    expect(await store.resolve(key.secret)).toBeNull();
  });

  it('rejects keys of suspended or missing orgs', async () => {
    const org = await makeOrg(f());
    const { key } = await create({ name: 'o', scopes: ['passes:read'], orgId: org.id }, org.id);
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(key.secret)).toMatchObject({ orgId: org.id });
    await run(h.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    expect(await store.resolve(key.secret)).toBeNull();
  });

  it('creates keys in live mode by default, or test mode on request', async () => {
    const store = createApiKeyStore(h.env, h.clock);
    const live = await create({ name: 'live', scopes: ['passes:read'], orgId: null });
    const test = await create({
      name: 'sandbox',
      scopes: ['passes:read'],
      mode: 'test',
      orgId: null,
    });
    expect(live.key).toMatchObject({ mode: 'live' });
    expect(test.key).toMatchObject({ mode: 'test' });
    expect(await store.resolve(live.key.secret)).toMatchObject({ mode: 'live' });
    expect(await store.resolve(test.key.secret)).toMatchObject({ mode: 'test' });
    const response = await h.call('/api/v1/api-keys?orgId=null', { headers: test.headers });
    expect(response.status).toBe(200);
    const list = ApiKeyListSchema.parse(await response.json());
    expect(list.items.find((k) => k.id === test.key.id)?.mode).toBe('test');
  });

  it('rejects an unknown mode', async () => {
    const { res } = await create({
      name: 'x',
      scopes: ['passes:read'],
      mode: 'staging',
      orgId: null,
    });
    expect(res.status).toBe(422);
  });

  it('works with keys inserted by the shared test factory', async () => {
    const fixture = await makeApiKey(f(), { scopes: ['passes:read'] });
    const auth = await createApiKeyStore(h.env, h.clock).resolve(fixture.secret);
    expect(auth).toMatchObject({ kind: 'api_key', keyId: fixture.id, scopes: ['passes:read'] });
  });

  it('throttles last_used writes', async () => {
    const { key } = await create({ name: 'k', scopes: ['passes:read'], orgId: null });
    const store = createApiKeyStore(h.env, h.clock);
    const used = async () =>
      (
        await first<{ last_used_at: number | null }>(
          h.env.DB,
          'SELECT last_used_at FROM api_keys WHERE id = ?',
          [key.id],
        )
      )?.last_used_at;
    await store.resolve(key.secret);
    const first1 = await used();
    expect(first1).toBe(h.clock.now());
    h.clock.advance(60_000);
    await store.resolve(key.secret);
    expect(await used()).toBe(first1);
    h.clock.advance(5 * 60_000);
    await store.resolve(key.secret);
    expect(await used()).toBe(h.clock.now());
  });

  it('rate limits per key with 429', async () => {
    h.restore();
    h = await harness({ RL_API_KEY: fakeLimiter(2) as unknown as RateLimit });
    const { key } = await create({ name: 'k', scopes: ['passes:read'], orgId: null });
    const headers = { authorization: `Bearer ${key.secret}` };
    const other = await makeApiKey(f(), { scopes: ['passes:read'] });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await h.call('/api/v1/passes', { headers })).status);
    }
    expect(statuses.slice(0, 2)).not.toContain(429);
    expect(statuses.slice(2)).toEqual([429, 429]);
    expect((await h.call('/api/v1/passes', { headers: other.headers })).status).not.toBe(429);
  });
});
