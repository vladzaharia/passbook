import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from './service.ts';
import {
  type CreatedKey,
  create,
  f,
  h,
  type KeyPage,
  keyBody,
  keyState,
  list,
  member,
  org,
  other,
  platformSession,
  revoke,
  setup,
  teardown,
} from './test-kit.ts';

beforeEach(setup);
afterEach(teardown);

describe('API key tenant authorization', () => {
  it('does not infer tenant membership from the platform administrator role', async () => {
    const session = await platformSession();
    const key = await makeApiKey(f(), { orgId: org.id });
    const before = await keyState();

    expect((await list(session.headers, org.id)).status).toBe(403);
    expect((await create(session.headers, keyBody(org.id))).status).toBe(403);
    expect((await revoke(session.headers, key.id, org.id)).status).toBe(403);
    expect((await revoke(session.headers, key.id)).status).toBe(404);
    expect(await keyState()).toEqual(before);
  });

  it.each(['integration_admin', 'org_admin'] as const)(
    'allows a %s to create, list and revoke only their organization keys',
    async (role) => {
      const { user, session } = await member(role);
      const old = await makeApiKey(f(), { orgId: org.id, name: 'Old tenant key' });
      const foreign = await makeApiKey(f(), { orgId: other.id });
      const platform = await makeApiKey(f());
      await run(h.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id IN (?, ?, ?)', [
        h.clock.now(),
        old.id,
        foreign.id,
        platform.id,
      ]);

      // integration_admin holds no pass capability, so it can only delegate connection scopes.
      const scopes = role === 'org_admin' ? ['passes:read'] : ['connections:read'];
      const response = await create(session.headers, { ...keyBody(org.id), scopes });
      expect(response.status).toBe(201);
      const created = (await response.json()) as CreatedKey;
      expect(created).toMatchObject({
        orgId: org.id,
        createdBy: user.id,
        scopes,
        mode: 'live',
      });
      expect(created.secret).toMatch(/^wlt_[\w-]{8}_[\w-]{43}$/);
      const row = await first<{ key_hash: string }>(
        h.env.DB,
        'SELECT key_hash FROM api_keys WHERE id = ?',
        [created.id],
      );
      expect(row?.key_hash).toBe(await sha256Hex(created.secret));
      const audit = await first<{ org_id: string; actor_id: string; detail: string }>(
        h.env.DB,
        "SELECT org_id, actor_id, detail FROM audit_log WHERE action = 'api_key.create' AND target_id = ?",
        [created.id],
      );
      expect(audit).toMatchObject({ org_id: org.id, actor_id: user.id });
      expect(audit?.detail).not.toContain(created.secret);

      const listed = await list(session.headers, org.id);
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as KeyPage;
      expect(new Set(page.items.map((item) => item.id))).toEqual(new Set([created.id, old.id]));
      expect(page.items.every((item) => item.orgId === org.id)).toBe(true);
      expect(page.revokedCount).toBe(1);
      expect(JSON.stringify(page)).not.toContain(created.secret);

      const bearer = { authorization: `Bearer ${created.secret}` };
      if (role === 'org_admin') {
        expect((await h.call(`/api/v1/passes?orgId=${org.id}`, { headers: bearer })).status).toBe(
          200,
        );
        expect((await h.call(`/api/v1/passes?orgId=${other.id}`, { headers: bearer })).status).toBe(
          403,
        );
        expect(
          (await h.call('/api/v1/passes', { method: 'POST', headers: bearer, json: {} })).status,
        ).toBe(403);
      }
      expect((await revoke(session.headers, created.id, org.id)).status).toBe(200);
      expect((await revoke(session.headers, created.id, org.id)).status).toBe(200);
      expect(await createApiKeyStore(h.env, h.clock).resolve(created.secret)).toBeNull();
      expect((await h.call('/api/v1/passes', { headers: bearer })).status).toBe(401);
      expect(
        await all(
          h.env.DB,
          "SELECT id FROM audit_log WHERE action = 'api_key.revoke' AND target_id = ?",
          [created.id],
        ),
      ).toHaveLength(1);
    },
  );

  it.each(['tenant', 'platform'] as const)(
    'rolls back a %s key revocation if its audit insert fails',
    async (scope) => {
      const session =
        scope === 'tenant' ? (await member('integration_admin')).session : await platformSession();
      const orgId = scope === 'tenant' ? org.id : undefined;
      const key = await makeApiKey(f(), { orgId: orgId ?? null });
      const before = await keyState();
      await run(
        h.env.DB,
        `CREATE TRIGGER fail_key_revoke_audit BEFORE INSERT ON audit_log
         WHEN NEW.action = 'api_key.revoke'
         BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
      );
      try {
        expect((await revoke(session.headers, key.id, orgId)).status).toBe(500);
        expect(await keyState()).toEqual(before);
      } finally {
        await run(h.env.DB, 'DROP TRIGGER fail_key_revoke_audit');
      }

      expect(await createApiKeyStore(h.env, h.clock).resolve(key.secret)).toMatchObject({
        keyId: key.id,
      });
      expect((await revoke(session.headers, key.id, orgId)).status).toBe(200);
      expect((await revoke(session.headers, key.id, orgId)).status).toBe(200);
      expect(
        await all(
          h.env.DB,
          "SELECT org_id, actor_id FROM audit_log WHERE action = 'api_key.revoke' AND target_id = ?",
          [key.id],
        ),
      ).toEqual([{ org_id: orgId ?? null, actor_id: session.userId }]);
    },
  );

  it('persists and resolves connection scopes on a tenant-created API key', async () => {
    const { session } = await member('integration_admin');
    const scopes = ['connections:read', 'connections:write'];
    const response = await create(session.headers, {
      orgId: org.id,
      name: 'Connection integration',
      scopes,
    });
    expect(response.status).toBe(201);
    const key = (await response.json()) as CreatedKey;
    expect(key).toMatchObject({ orgId: org.id, scopes });
    const stored = await first<{ scopes: string }>(
      h.env.DB,
      'SELECT scopes FROM api_keys WHERE id = ?',
      [key.id],
    );
    expect(JSON.parse(stored?.scopes ?? 'null')).toEqual(scopes);
    expect(await createApiKeyStore(h.env, h.clock).resolve(key.secret)).toMatchObject({
      kind: 'api_key',
      keyId: key.id,
      orgId: org.id,
      scopes,
    });
    const listed = await list(session.headers, org.id);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as KeyPage).items).toEqual([
      expect.objectContaining({ id: key.id, orgId: org.id, scopes }),
    ]);
  });

  it('cannot mint scopes beyond the creator role, in the service or in SQL', async () => {
    const { session } = await member('integration_admin');
    const before = await keyState();
    for (const scopes of [
      ['passes:write'],
      ['messages:write'],
      ['holders:write'],
      ['scans:read'],
      ['passes:read', 'connections:write'],
    ]) {
      const response = await create(session.headers, { ...keyBody(org.id), scopes });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'API_KEY_SCOPE_EXCEEDS_CREATOR' });
    }
    expect(await keyState()).toEqual(before);
    expect(
      (await create(session.headers, { ...keyBody(org.id), scopes: ['connections:write'] })).status,
    ).toBe(201);
    // The grant refuses a platform key insert whose admin session is not live, with nothing written.
    const { createKey } = await import('./repo.ts');
    const ctx = createServiceContext(h.env, { clock: h.clock });
    const row = {
      id: 'k-sql',
      org_id: null,
      name: 'x',
      prefix: 'sqlscope',
      key_hash: 'h',
      scopes: '["passes:write"]',
      mode: 'live' as const,
      created_by: session.userId,
      created_at: 1,
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    };
    await expect(
      createKey(
        ctx,
        row,
        { kind: 'platform' as const, userId: session.userId, sessionId: 'not-a-session' },
        { orgId: null, actorType: 'user', actorId: session.userId, action: 'api_key.create' },
      ),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect(await first(h.env.DB, 'SELECT 1 AS x FROM api_keys WHERE id = ?', ['k-sql'])).toBeNull();
  });

  it('lets an org admin mint pass and message scopes, and the key mode follows the session', async () => {
    const { session } = await member('org_admin');
    const live = await create(session.headers, {
      ...keyBody(org.id),
      scopes: ['passes:write', 'messages:write'],
      mode: 'test',
    });
    expect(live.status).toBe(201);
    expect(await live.json()).toMatchObject({ mode: 'live' });
    const test = await create(
      { ...session.headers, 'x-passbook-mode': 'test' },
      { ...keyBody(org.id), mode: 'live' },
    );
    expect(test.status).toBe(201);
    expect(await test.json()).toMatchObject({ mode: 'test' });
  });

  it('preserves tenant key mode and expiry without disclosing the secret again', async () => {
    const { session } = await member('integration_admin');
    const expiresAt = h.clock.now() + 60_000;
    const response = await create(
      { ...session.headers, 'x-passbook-mode': 'test' },
      {
        ...keyBody(org.id),
        scopes: ['connections:read'],
        mode: 'test',
        expiresAt,
      },
    );
    expect(response.status).toBe(201);
    const key = (await response.json()) as CreatedKey;
    expect(key).toMatchObject({ orgId: org.id, mode: 'test', expiresAt });
    const store = createApiKeyStore(h.env, h.clock);
    expect(await store.resolve(key.secret)).toMatchObject({ orgId: org.id, mode: 'test' });
    const page = await (await list(session.headers, org.id)).json();
    expect(JSON.stringify(page)).not.toContain(key.secret);
    h.clock.advance(60_000);
    expect(await store.resolve(key.secret)).toBeNull();
  });

  it.each([false, true])(
    'allows read-only listing but not writes (platform administrator: %s)',
    async (platformAdmin) => {
      const { session } = await member('read_only', { platformAdmin });
      const own = await makeApiKey(f(), { orgId: org.id });
      await makeApiKey(f(), { orgId: other.id });
      await makeApiKey(f());
      const before = await keyState();
      const response = await list(session.headers, org.id);
      expect(response.status).toBe(200);
      const page = (await response.json()) as KeyPage;
      expect(page.items).toEqual([expect.objectContaining({ id: own.id, orgId: org.id })]);
      expect((await create(session.headers, keyBody(org.id))).status).toBe(403);
      expect((await revoke(session.headers, own.id, org.id)).status).toBe(403);
      expect(await keyState()).toEqual(before);
    },
  );

  it('requires the tenant integrations capability and CSRF for writes', async () => {
    const { session: author } = await member('template_author');
    const key = await makeApiKey(f(), { orgId: org.id });
    const before = await keyState();
    expect((await list(author.headers, org.id)).status).toBe(403);
    expect((await create(author.headers, keyBody(org.id))).status).toBe(403);
    expect((await revoke(author.headers, key.id, org.id)).status).toBe(403);

    const { session: manager } = await member('integration_admin');
    const noCsrf = { cookie: manager.headers.cookie ?? '' };
    expect((await create(noCsrf, keyBody(org.id))).status).toBe(403);
    expect((await revoke(noCsrf, key.id, org.id)).status).toBe(403);
    expect(await keyState()).toEqual(before);
  });

  it('does not allow tenant members to escalate to another org or null-org keys', async () => {
    const { session } = await member('integration_admin');
    const platform = await makeApiKey(f());
    const before = await keyState();
    expect((await list(session.headers)).status).toBe(403);
    expect((await list(session.headers, other.id)).status).toBe(403);
    expect(
      (await create(session.headers, { name: 'No org', scopes: ['passes:read'] })).status,
    ).toBe(400);
    expect((await create(session.headers, keyBody(null))).status).toBe(403);
    expect((await create(session.headers, keyBody(other.id))).status).toBe(403);
    expect((await revoke(session.headers, platform.id, org.id)).status).toBe(404);
    expect(await keyState()).toEqual(before);
  });

  it('masks foreign and platform key IDs exactly like unknown IDs', async () => {
    const { session } = await member('integration_admin');
    const foreign = await makeApiKey(f(), { orgId: other.id });
    const platform = await makeApiKey(f());
    const before = await keyState();
    const problems = [];
    for (const id of ['missing-key', foreign.id, platform.id]) {
      const response = await revoke(session.headers, id, org.id);
      expect(response.status).toBe(404);
      const { requestId: _requestId, ...problem } = (await response.json()) as Record<
        string,
        unknown
      >;
      problems.push(problem);
    }
    expect(problems[1]).toEqual(problems[0]);
    expect(problems[2]).toEqual(problems[0]);
    expect(await keyState()).toEqual(before);
  });

  it('preserves platform administrator management of null-org keys', async () => {
    // Storage lasts for the whole file; the platform list must start empty.
    await run(h.env.DB, 'DELETE FROM api_keys WHERE org_id IS NULL');
    const session = await platformSession();
    const tenantKey = await makeApiKey(f(), { orgId: org.id });
    const scopes = ['passes:read', 'connections:read', 'connections:write'];
    const response = await create(session.headers, { ...keyBody(null), scopes });
    expect(response.status).toBe(201);
    const key = (await response.json()) as CreatedKey;
    expect(key.orgId).toBeNull();
    expect(await createApiKeyStore(h.env, h.clock).resolve(key.secret)).toMatchObject({
      orgId: null,
      scopes,
    });
    const listed = await list(session.headers);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as KeyPage).items).toEqual([
      expect.objectContaining({ id: key.id, orgId: null }),
    ]);
    expect((await revoke(session.headers, tenantKey.id)).status).toBe(404);
    expect((await revoke(session.headers, key.id)).status).toBe(200);
    expect(await createApiKeyStore(h.env, h.clock).resolve(key.secret)).toBeNull();
  });

  it('keeps management session-only and existing bearer scopes and org restrictions intact', async () => {
    const tenantKey = await makeApiKey(f(), { orgId: org.id, scopes: ['passes:read'] });
    const platformKey = await makeApiKey(f(), { scopes: ['passes:read'] });
    const before = await keyState();
    for (const key of [tenantKey, platformKey]) {
      expect((await list(key.headers, org.id)).status).toBe(401);
      expect((await create(key.headers, keyBody(org.id))).status).toBe(401);
      expect((await revoke(key.headers, tenantKey.id, org.id)).status).toBe(401);
    }
    expect(await keyState()).toEqual(before);
    expect(
      (await h.call(`/api/v1/passes?orgId=${org.id}`, { headers: tenantKey.headers })).status,
    ).toBe(200);
    const foreign = await h.call(`/api/v1/passes?orgId=${other.id}`, {
      headers: tenantKey.headers,
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: 'ORG_FORBIDDEN' });
    expect(
      (await h.call(`/api/v1/passes?orgId=${other.id}`, { headers: platformKey.headers })).status,
    ).toBe(200);
    const write = await h.call('/api/v1/passes', {
      method: 'POST',
      headers: tenantKey.headers,
      json: {},
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: 'MISSING_SCOPE' });
  });
});
