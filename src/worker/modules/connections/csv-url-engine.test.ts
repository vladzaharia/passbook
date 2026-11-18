import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, type SessionFixture } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { setDeps } from './deps.ts';
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

const CSV = 'Id,Name\nA1,Maya\nA2,Jo';
const PUB = 'https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?gid=0&single=true&output=csv';
const HOST = 'https://doc-0k-sheets.googleusercontent.com/pub/abc/export';
const testConfig = (url = PUB) =>
  call('POST', '/api/v1/connections/test-config', {
    orgId: kit.org.id,
    connectorType: 'csv-url',
    config: { url, idColumn: 'Id' },
  });
const dns = (bad: string[] = []) => ({
  resolve: async (host: string) => (bad.includes(host) ? ['10.0.0.9'] : ['93.184.216.34']),
});

describe('csv-url through the engine', () => {
  it('follows the publish link to its export host and reads the sheet', async () => {
    const seen: string[] = [];
    setDeps({
      resolver: dns(),
      fetchImpl: async (input) => {
        seen.push(String(input));
        return String(input) === PUB
          ? new Response(null, { status: 307, headers: { location: HOST } })
          : new Response(CSV, { headers: { 'content-type': 'text/csv' } });
      },
    });
    const res = await testConfig();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true });
    expect(seen).toEqual([PUB, HOST, PUB, HOST].slice(0, seen.length));
    expect(seen).toContain(HOST);
    expect(JSON.stringify(res.json)).not.toContain('2PACX');
  });

  it('refuses a redirect to a private host and never fetches it', async () => {
    const seen: string[] = [];
    setDeps({
      resolver: dns(['internal.example.net']),
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: 'https://internal.example.net/x' },
        });
      },
    });
    const res = await testConfig();
    expect(res.json.ok).toBe(false);
    expect(seen.every((u) => !u.includes('internal.example.net'))).toBe(true);
  });

  it('refuses an http hop, and a chain longer than three', async () => {
    let n = 0;
    setDeps({
      resolver: dns(),
      fetchImpl: async () => {
        n++;
        return new Response(null, {
          status: 302,
          headers: { location: `https://h${n}.example.net/x` },
        });
      },
    });
    expect((await testConfig()).json.ok).toBe(false);
    expect(n).toBe(4);
    setDeps({
      resolver: dns(),
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: 'http://plain.example.net/x' } }),
    });
    expect((await testConfig()).json.ok).toBe(false);
  });

  it('caps the response at 2 MB for this connector, where others keep 256 KB', async () => {
    const rows = (n: number, width: number) =>
      `Id,Note\n${Array.from({ length: n }, (_, i) => `A${i},${'x'.repeat(width)}`).join('\n')}`;
    setDeps({ resolver: dns(), fetchImpl: async () => new Response(rows(1900, 1100)) });
    expect((await testConfig()).json).toMatchObject({ ok: false, errorCode: 'UPSTREAM' });
    // 400 KB: over the 256 KB default, under this connector's cap.
    setDeps({ resolver: dns(), fetchImpl: async () => new Response(rows(1000, 400)) });
    expect((await testConfig()).json.ok).toBe(true);
  });

  it("the connection test holds redirects to the runtime's deny list, trailing dot included", async () => {
    const env = kit.env as unknown as { SSRF_DENY_HOSTS?: string };
    const before = env.SSRF_DENY_HOSTS;
    env.SSRF_DENY_HOSTS = 'plrs.im';
    try {
      for (const to of ['https://id.plrs.im/x', 'https://wallet.plrs.im./x']) {
        const seen: string[] = [];
        setDeps({
          resolver: dns(),
          fetchImpl: async (input) => {
            seen.push(String(input));
            return new Response(null, { status: 302, headers: { location: to } });
          },
        });
        expect((await testConfig()).json.ok).toBe(false);
        expect(seen).toEqual([PUB]);
      }
    } finally {
      if (before === undefined) delete env.SSRF_DENY_HOSTS;
      else env.SSRF_DENY_HOSTS = before;
    }
  });

  it('refuses an unsafe link when the connection is saved', async () => {
    for (const url of ['https://localhost/a.csv', 'https://10.0.0.1/a.csv']) {
      const res = await call('POST', '/api/v1/connections', {
        orgId: kit.org.id,
        name: 'Sheet',
        connectorType: 'csv-url',
        config: { url, idColumn: 'Id' },
      });
      expect(res.status).toBe(422);
    }
  });
});
