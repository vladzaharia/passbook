import { beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { ConnectionSync } from '../../workflows/connection-sync.ts';
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

async function call(method: string, path: string, body?: unknown, headers = admin()) {
  const res = await app.request(
    path,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const create = (over: Record<string, unknown> = {}) =>
  call('POST', '/api/v1/connections', {
    orgId: kit.org.id,
    connectorType: 'http-json',
    name: 'Members',
    config: { baseUrl: 'https://api.example.com/v1' },
    secrets: { token: 'tok-api-secret-xyz' },
    ...over,
  });

describe('auth', () => {
  it('requires an admin session', async () => {
    const anon = await app.request('/api/v1/connections', {}, kit.env);
    expect(anon.status).toBe(401);
    const user = await call('GET', '/api/v1/connections', undefined, fake.user());
    expect(user.status).toBe(403);
    const key = await call('GET', '/api/v1/connectors', undefined, fake.apiKey());
    expect(key.status).toBe(401);
  });

  it('requires the CSRF token for writes', async () => {
    const { 'x-csrf-token': _csrf, ...noCsrf } = admin();
    const res = await call('POST', '/api/v1/connections', { orgId: kit.org.id }, noCsrf);
    expect(res.status).toBe(403);
  });
});

describe('connectors', () => {
  it('lists the built-in types with JSON Schemas for the form', async () => {
    const res = await call('GET', '/api/v1/connectors');
    expect(res.status).toBe(200);
    const types = res.json.items.map((c: { type: string }) => c.type).sort();
    expect(types).toEqual(['demo', 'http-json', 'webhook-push']);
    const http = res.json.items.find((c: { type: string }) => c.type === 'http-json');
    expect(http.configSchema.properties.baseUrl).toBeDefined();
    expect(http.secretSchema.properties.token).toBeDefined();
    expect(http.capabilities).toMatchObject({ poll: true, delta: true, webhook: true });
    const demo = res.json.items.find((c: { type: string }) => c.type === 'demo');
    expect(demo.secretSchema).toBeNull();
    expect(Object.keys(demo.outputFields)).toContain('memberName');
  });

  it('gets one type and 404s an unknown one', async () => {
    expect((await call('GET', '/api/v1/connectors/demo')).json.type).toBe('demo');
    const missing = await call('GET', '/api/v1/connectors/nope');
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe('CONNECTOR_NOT_FOUND');
  });
});

describe('connections', () => {
  it('creates, reads, updates and deletes without ever returning secrets', async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.text).not.toContain('tok-api-secret');
    expect(created.json).toMatchObject({ hasCredential: true, connectorType: 'http-json' });
    const id = created.json.id as string;

    const got = await call('GET', `/api/v1/connections/${id}`);
    expect(got.status).toBe(200);
    expect(got.text).not.toContain('tok-api-secret');
    expect(got.json).toMatchObject({ id, runs: [], metrics: { passCount: 0, p50Ms: null } });

    const patched = await call('PATCH', `/api/v1/connections/${id}`, {
      name: 'Renamed',
      secrets: { token: 'new-token-value-123' },
    });
    expect(patched.status).toBe(200);
    expect(patched.text).not.toContain('new-token-value');
    expect(patched.json.name).toBe('Renamed');

    const list = await call('GET', `/api/v1/connections?orgId=${kit.org.id}`);
    expect(list.json.items.map((c: { id: string }) => c.id)).toEqual([id]);

    const del = await call('DELETE', `/api/v1/connections/${id}`);
    expect(del.json).toEqual({ ok: true });
    expect((await call('GET', `/api/v1/connections/${id}`)).status).toBe(404);
  });

  it('PATCH edits config, secrets, rate limit and concurrency; config and secrets bump generation', async () => {
    const created = await create();
    const id = created.json.id as string;
    const rate = await call('PATCH', `/api/v1/connections/${id}`, {
      requestsPerMinute: 30,
      maxConcurrency: 2,
    });
    expect(rate.json).toMatchObject({ requestsPerMinute: 30, maxConcurrency: 2 });
    const cleared = await call('PATCH', `/api/v1/connections/${id}`, {
      requestsPerMinute: null,
      maxConcurrency: null,
    });
    expect(cleared.json).toMatchObject({ requestsPerMinute: null, maxConcurrency: null });
    const gen = async () =>
      (
        await first<{ generation: number }>(
          kit.env.DB,
          'SELECT generation FROM connections WHERE id = ?',
          [id],
        )
      )?.generation;
    expect(await gen()).toBe(1);
    const config = await call('PATCH', `/api/v1/connections/${id}`, {
      config: { baseUrl: 'https://api.example.com/v2' },
    });
    expect(config.json.config).toMatchObject({ baseUrl: 'https://api.example.com/v2' });
    expect(await gen()).toBe(2);
    const secrets = await call('PATCH', `/api/v1/connections/${id}`, {
      secrets: { token: 'rotated-token-value-1' },
    });
    expect(secrets.status).toBe(200);
    expect(secrets.text).not.toContain('rotated-token');
    expect(await gen()).toBe(3);
  });

  it('shows a generated webhook secret once, on create and on rotation only', async () => {
    const created = await create({
      connectorType: 'webhook-push',
      config: {},
      secrets: undefined,
      mode: 'webhook',
    });
    expect(created.json.webhookSecret).toMatch(/^whsec_/);
    expect(created.json.webhookUrl).toContain(`/hooks/connections/${created.json.id}`);
    const again = await call('GET', `/api/v1/connections/${created.json.id}`);
    expect(again.text).not.toContain(created.json.webhookSecret);
    const rotated = await call('POST', `/api/v1/connections/${created.json.id}/webhook-secret`);
    expect(rotated.json.webhookSecret).toMatch(/^whsec_/);
    expect(rotated.json.webhookSecret).not.toBe(created.json.webhookSecret);
  });

  it('answers validation problems with field issues', async () => {
    const res = await create({ config: { baseUrl: 'not a url' } });
    expect(res.status).toBe(422);
    expect(res.json.issues[0].path).toMatch(/^config\./);
    const ssrf = await create({ config: { baseUrl: 'http://169.254.169.254/' } });
    expect(ssrf.status).toBe(422);
    const schema = await call('POST', '/api/v1/connections', { name: 'x' });
    expect(schema.status).toBe(422);
  });

  it('keeps tenants apart in listings', async () => {
    const { makeOrg } = await import('../../../../test/helpers/index.ts');
    const other = await makeOrg(kit);
    const mine = await create();
    const theirs = await create({ orgId: other.id });
    const list = await call('GET', `/api/v1/connections?orgId=${other.id}`);
    expect(list.json.items.map((c: { id: string }) => c.id)).toEqual([theirs.json.id]);
    expect(list.text).not.toContain(mine.json.id);
  });

  it('runs a test, lists runs and summarizes health', async () => {
    const created = await call('POST', '/api/v1/connections', {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Demo',
      config: { count: 2 },
    });
    const id = created.json.id as string;
    const test = await call('POST', `/api/v1/connections/${id}/test`);
    expect(test.json).toMatchObject({ ok: true });
    const runs = await call('GET', `/api/v1/connections/${id}/runs?limit=5`);
    expect(runs.json.items).toHaveLength(1);
    expect(runs.json.items[0]).toMatchObject({ trigger: 'test', outcome: 'unchanged' });
    expect(runs.json.nextCursor).toBeNull();
    const summary = await call('GET', '/api/v1/connections/summary');
    expect(summary.status).toBe(200);
    expect(summary.json.total).toBeGreaterThanOrEqual(1);
  });

  it('is described in the OpenAPI document', async () => {
    const res = await app.request('/api/v1/openapi.json', {}, kit.env);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    for (const path of [
      '/api/v1/connections',
      '/api/v1/connections/{id}/sync',
      '/api/v1/connections/{id}/runs',
      '/api/v1/connections/{id}/webhook-secret',
      '/hooks/connections/{id}',
    ]) {
      expect(doc.paths[path], path).toBeDefined();
    }
  });
});

describe('ConnectionSync workflow class', () => {
  it('runs the sync through the workflow entrypoint', async () => {
    const created = await call('POST', '/api/v1/connections', {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Demo',
      config: { count: 1 },
    });
    const id = created.json.id as string;
    const names: string[] = [];
    const step = {
      do: async (name: string, a: unknown, b?: unknown) => {
        names.push(name);
        return (typeof a === 'function' ? a : b) instanceof Function
          ? await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)()
          : undefined;
      },
      sleep: async () => {},
    };
    // The native constructor needs a real runtime handle; run() only reads this.env.
    const wf = Object.assign(Object.create(ConnectionSync.prototype), {
      env: kit.env,
    }) as ConnectionSync;
    await wf.run(
      {
        payload: { connectionId: id, generation: 1, trigger: 'admin' },
        timestamp: new Date(),
        instanceId: 'wf-instance-1',
      } as never,
      step as never,
    );
    expect(names).toEqual([
      'start',
      'limits',
      'page-0',
      'page-0-apply-0',
      'page-0-cursor',
      'finish',
    ]);
    const run = await first<{ outcome: string }>(
      kit.env.DB,
      'SELECT outcome FROM connection_runs WHERE id = ?',
      ['wf-instance-1'],
    );
    expect(run?.outcome).toBe('unchanged');
  });
});
