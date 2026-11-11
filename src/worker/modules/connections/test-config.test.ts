import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeApiKey,
  makeOrg,
  makeSession,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { setDeps } from './deps.ts';
import { sampleFields } from './test-config.ts';
import { addMembership, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
let session: SessionFixture;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  kit = await makeKit();
  session = await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] });
  await addMembership(kit, kit.actor.id, ['org_admin']);
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

async function call(method: string, path: string, body?: unknown, headers = session.headers) {
  const res = await app.request(
    path,
    {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    kit.env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('sampleFields', () => {
  it('flattens leaves to pointers with short previews', () => {
    expect(
      sampleFields({
        memberName: 'Maya Chen',
        tier: { name: 'Gold' },
        'a/b': 1,
        long: 'x'.repeat(200),
      }),
    ).toEqual([
      { pointer: '/memberName', preview: 'Maya Chen' },
      { pointer: '/tier/name', preview: 'Gold' },
      { pointer: '/a~1b', preview: '1' },
      { pointer: '/long', preview: `${'x'.repeat(120)}…` },
    ]);
  });
});

describe('POST /connections/test-config', () => {
  it('returns the first demo record without storing anything', async () => {
    const res = await call('POST', '/api/v1/connections/test-config', {
      orgId: kit.org.id,
      connectorType: 'demo',
      config: { count: 3 },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.sample.map((f: { pointer: string }) => f.pointer)).toContain('/memberName');
    const rows = await all(kit.env.DB, 'SELECT id FROM connections WHERE org_id = ?', [kit.org.id]);
    expect(rows).toHaveLength(0);
  });

  it('fetches through safe fetch with the given bearer token', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    setDeps({
      fetchImpl: async (input, init) => {
        seen.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify({ data: { name: 'Maya', points: 3 } }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const res = await call('POST', '/api/v1/connections/test-config', {
      orgId: kit.org.id,
      connectorType: 'http-json',
      config: {
        baseUrl: 'https://api.example.com/v1',
        recordPath: '/members/{ref}',
        recordPointer: '/data',
        testRef: 'm-1',
        auth: { type: 'bearer' },
      },
      secrets: { token: 'tok-secret' },
    });
    expect(res.json).toMatchObject({ ok: true });
    expect(res.json.sample).toEqual([
      { pointer: '/name', preview: 'Maya' },
      { pointer: '/points', preview: '3' },
    ]);
    expect(seen).toEqual([
      { url: 'https://api.example.com/v1/members/m-1', auth: 'Bearer tok-secret' },
      { url: 'https://api.example.com/v1/members/m-1', auth: 'Bearer tok-secret' },
    ]);
    expect(JSON.stringify(res.json)).not.toContain('tok-secret');
  });

  it('uses an org-bound write key for a secret-bearing unsaved test without persisting secrets', async () => {
    const writeKey = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
    const readKey = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    const other = await makeOrg(kit);
    const seen: string[] = [];
    setDeps({
      fetchImpl: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify({ data: { name: 'Maya' } }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const input = {
      orgId: kit.org.id,
      connectorType: 'http-json',
      config: {
        baseUrl: 'https://api.example.com/v1',
        recordPath: '/members/{ref}',
        recordPointer: '/data',
        testRef: 'm-1',
        auth: { type: 'bearer' },
      },
      secrets: { token: 'unsaved-api-token' },
    };
    const deniedScope = await call(
      'POST',
      '/api/v1/connections/test-config',
      input,
      readKey.headers,
    );
    expect(deniedScope.status).toBe(403);
    expect(deniedScope.json.code).toBe('MISSING_SCOPE');
    expect(
      (
        await call(
          'POST',
          '/api/v1/connections/test-config',
          { ...input, orgId: other.id },
          writeKey.headers,
        )
      ).status,
    ).toBe(403);
    expect(seen).toEqual([]);
    const result = await call('POST', '/api/v1/connections/test-config', input, writeKey.headers);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      ok: true,
      sample: [{ pointer: '/name', preview: 'Maya' }],
    });
    expect(JSON.stringify(result.json)).not.toContain('unsaved-api-token');
    expect(seen).toEqual(['Bearer unsaved-api-token', 'Bearer unsaved-api-token']);
    expect(
      await all(kit.env.DB, 'SELECT id FROM connections WHERE org_id = ?', [kit.org.id]),
    ).toEqual([]);
    expect(
      await all(kit.env.DB, 'SELECT id FROM credentials WHERE org_id = ?', [kit.org.id]),
    ).toEqual([]);
    const audits = await all(
      kit.env.DB,
      'SELECT actor_type, actor_id, detail FROM audit_log WHERE org_id = ?',
      [kit.org.id],
    );
    expect(audits).toEqual([
      expect.objectContaining({ actor_type: 'api_key', actor_id: writeKey.id }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('unsaved-api-token');
    expect(JSON.stringify(audits)).not.toContain(writeKey.secret);
  });

  it('refuses private hosts and reports failures by code', async () => {
    const unsafe = await call('POST', '/api/v1/connections/test-config', {
      orgId: kit.org.id,
      connectorType: 'http-json',
      config: { baseUrl: 'https://127.0.0.1/v1' },
    });
    expect(unsafe.status).toBe(422);
    const failing = await call('POST', '/api/v1/connections/test-config', {
      orgId: kit.org.id,
      connectorType: 'demo',
      config: { fail: 'auth' },
    });
    expect(failing.json).toMatchObject({ ok: false, errorCode: 'AUTH' });
  });
});

describe('list', () => {
  it('searches by name and counts bound passes', async () => {
    const made = await call('POST', '/api/v1/connections', {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Member sync',
      config: {},
    });
    await call('POST', '/api/v1/connections', {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Other',
      config: {},
    });
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ? WHERE org_id = ?', [
      made.json.id,
      kit.org.id,
    ]);
    const res = await call('GET', `/api/v1/connections?orgId=${kit.org.id}&q=member`);
    expect(res.json.items.map((i: { name: string }) => i.name)).toEqual(['Member sync']);
    expect(res.json.items[0].passCount).toBe(0);
  });
});
