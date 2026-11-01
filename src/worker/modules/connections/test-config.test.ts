import { beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import { setDeps } from './deps.ts';
import { sampleFields } from './test-config.ts';
import { type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
let fake: ReturnType<typeof fakeAuth>;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  kit = await makeKit();
  fake = fakeAuth();
  app = createApp({ stores: fake.stores, clock: kit.clock });
});

const admin = () => fake.session({ userId: kit.actor.id, roles: ['admin', 'user'] });
async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(
    path,
    {
      method,
      headers: { ...admin(), ...(body ? { 'content-type': 'application/json' } : {}) },
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
    const res = await call('GET', '/api/v1/connections?q=member');
    expect(res.json.items.map((i: { name: string }) => i.name)).toEqual(['Member sync']);
    expect(res.json.items[0].passCount).toBe(0);
  });
});
