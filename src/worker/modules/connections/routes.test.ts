import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  editApiKeyIdentity,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { connectors } from '../../connectors/registry.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConnectionSync } from '../../workflows/connection-sync.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { getConnection } from './repo.ts';
import { seedConnectionWorkflow } from './runtime-fixtures.ts';
import { readConnectorSecrets, readWebhookSecret } from './secrets.ts';
import { addMembership, type Kit, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
let adminSession: SessionFixture;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  kit = await makeKit();
  adminSession = await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] });
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
afterEach(() => vi.restoreAllMocks());

const admin = () => adminSession.headers;

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
  it('requires authentication and a tenant membership, not just a platform role', async () => {
    const anon = await app.request(`/api/v1/connections?orgId=${kit.org.id}`, {}, kit.env);
    expect(anon.status).toBe(401);
    const outsider = await makeUser(kit);
    const user = await makeSession(kit, { userId: outsider.id });
    expect(
      (await call('GET', `/api/v1/connections?orgId=${kit.org.id}`, undefined, user.headers))
        .status,
    ).toBe(403);
  });

  it('requires the CSRF token for writes', async () => {
    const { 'x-csrf-token': _csrf, ...noCsrf } = admin();
    const res = await call('POST', '/api/v1/connections', { orgId: kit.org.id }, noCsrf);
    expect(res.status).toBe(403);
  });
});

describe('tenant capability gates', () => {
  it('denies a platform administrator without membership across tenant endpoints', async () => {
    const created = await create();
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const outsider = await makeUser(kit);
    const session = await makeSession(kit, { userId: outsider.id, roles: ['admin', 'user'] });
    const headers = session.headers;
    const connection = await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id]);
    const denied = [
      await call('GET', `/api/v1/connections?orgId=${kit.org.id}`, undefined, headers),
      await call('GET', `/api/v1/connections/summary?orgId=${kit.org.id}`, undefined, headers),
      await call('GET', `/api/v1/connections/${id}`, undefined, headers),
      await call('GET', `/api/v1/connections/${id}/runs`, undefined, headers),
      await call(
        'POST',
        '/api/v1/connections',
        {
          orgId: kit.org.id,
          connectorType: 'demo',
          name: 'No access',
          config: { count: 1 },
        },
        headers,
      ),
      await call(
        'POST',
        '/api/v1/connections/test-config',
        {
          orgId: kit.org.id,
          connectorType: 'demo',
          config: { count: 1 },
        },
        headers,
      ),
      await call('POST', `/api/v1/connections/${id}/test`, undefined, headers),
      await call('POST', `/api/v1/connections/${id}/sync`, undefined, headers),
      await call('POST', `/api/v1/connections/${id}/webhook-secret`, undefined, headers),
      await call('PATCH', `/api/v1/connections/${id}`, { name: 'No access' }, headers),
      await call('DELETE', `/api/v1/connections/${id}`, undefined, headers),
    ];
    // List, create and test-config name the organization (403); by-id routes mask it (404).
    expect(denied.map((response) => response.status)).toEqual([
      403, 403, 404, 404, 403, 403, 404, 404, 404, 404, 404,
    ]);
    expect(await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id])).toEqual(
      connection,
    );
    expect(
      await first(kit.env.DB, 'SELECT id FROM connection_runs WHERE connection_id = ?', [id]),
    ).toBeNull();
  });

  it('allows an integration administrator without the platform admin role', async () => {
    const user = await makeUser(kit);
    await addMembership(kit, user.id, ['integration_admin']);
    const session = await makeSession(kit, { userId: user.id });
    const headers = session.headers;
    const created = await call(
      'POST',
      '/api/v1/connections',
      {
        orgId: kit.org.id,
        connectorType: 'demo',
        name: 'Managed',
        config: { count: 1 },
      },
      headers,
    );
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(
      (await call('GET', `/api/v1/connections?orgId=${kit.org.id}`, undefined, headers)).json.items,
    ).toEqual([expect.objectContaining({ id })]);
    expect(
      (await call('GET', `/api/v1/connections/summary?orgId=${kit.org.id}`, undefined, headers))
        .json.total,
    ).toBe(1);
    expect((await call('GET', `/api/v1/connections/${id}`, undefined, headers)).status).toBe(200);
    expect(
      (
        await call(
          'POST',
          '/api/v1/connections/test-config',
          {
            orgId: kit.org.id,
            connectorType: 'demo',
            config: { count: 1 },
          },
          headers,
        )
      ).status,
    ).toBe(200);
    expect((await call('POST', `/api/v1/connections/${id}/test`, undefined, headers)).status).toBe(
      200,
    );
    expect(
      (await call('GET', `/api/v1/connections/${id}/runs`, undefined, headers)).json.items,
    ).toHaveLength(1);
    expect(
      (await call('PATCH', `/api/v1/connections/${id}`, { name: 'Updated' }, headers)).json.name,
    ).toBe('Updated');
    expect((await call('DELETE', `/api/v1/connections/${id}`, undefined, headers)).status).toBe(
      200,
    );
  });

  it('lets read-only members read but denies all tenant mutations', async () => {
    const created = await create();
    const id = created.json.id as string;
    const user = await makeUser(kit);
    await addMembership(kit, user.id, ['read_only']);
    const session = await makeSession(kit, { userId: user.id });
    const headers = session.headers;
    const connection = await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id]);
    expect(
      (await call('GET', `/api/v1/connections?orgId=${kit.org.id}`, undefined, headers)).json.items,
    ).toEqual([expect.objectContaining({ id })]);
    expect(
      (await call('GET', `/api/v1/connections/summary?orgId=${kit.org.id}`, undefined, headers))
        .json.total,
    ).toBe(1);
    expect((await call('GET', `/api/v1/connections/${id}`, undefined, headers)).status).toBe(200);
    expect((await call('GET', `/api/v1/connections/${id}/runs`, undefined, headers)).status).toBe(
      200,
    );
    const denied = [
      await call(
        'POST',
        '/api/v1/connections',
        {
          orgId: kit.org.id,
          connectorType: 'demo',
          name: 'Forbidden',
          config: { count: 1 },
        },
        headers,
      ),
      await call(
        'POST',
        '/api/v1/connections/test-config',
        {
          orgId: kit.org.id,
          connectorType: 'demo',
          config: { count: 1 },
        },
        headers,
      ),
      await call('POST', `/api/v1/connections/${id}/test`, undefined, headers),
      await call('POST', `/api/v1/connections/${id}/sync`, undefined, headers),
      await call('POST', `/api/v1/connections/${id}/webhook-secret`, undefined, headers),
      await call('PATCH', `/api/v1/connections/${id}`, { name: 'Forbidden' }, headers),
      await call('DELETE', `/api/v1/connections/${id}`, undefined, headers),
    ];
    for (const response of denied) expect(response.status).toBe(403);
    expect(await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id])).toEqual(
      connection,
    );
    expect(
      await first(kit.env.DB, 'SELECT id FROM connection_runs WHERE connection_id = ?', [id]),
    ).toBeNull();
  });

  it('scopes lists and summaries and rejects forged orgs even for a known connection id', async () => {
    const other = await makeOrg(kit);
    await addMembership(kit, kit.actor.id, ['org_admin'], other.id);
    const own = await create();
    const foreign = await create({ orgId: other.id, name: 'Other tenant' });
    const foreignId = foreign.json.id as string;
    const member = await makeUser(kit);
    await addMembership(kit, member.id, ['integration_admin']);
    const session = await makeSession(kit, { userId: member.id });
    const headers = session.headers;
    expect(
      (await call('GET', `/api/v1/connections?orgId=${kit.org.id}`, undefined, headers)).json.items,
    ).toEqual([expect.objectContaining({ id: own.json.id })]);
    expect(
      (await call('GET', `/api/v1/connections/summary?orgId=${kit.org.id}`, undefined, headers))
        .json.total,
    ).toBe(1);
    const before = await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [foreignId]);
    const denied = [
      await call('GET', `/api/v1/connections?orgId=${other.id}`, undefined, headers),
      await call('GET', `/api/v1/connections/summary?orgId=${other.id}`, undefined, headers),
      await call('GET', `/api/v1/connections/${foreignId}?orgId=${kit.org.id}`, undefined, headers),
      await call(
        'GET',
        `/api/v1/connections/${foreignId}/runs?orgId=${kit.org.id}`,
        undefined,
        headers,
      ),
      await call(
        'POST',
        '/api/v1/connections',
        {
          orgId: other.id,
          connectorType: 'demo',
          name: 'Forged',
          config: { count: 1 },
        },
        headers,
      ),
      await call(
        'POST',
        '/api/v1/connections/test-config',
        {
          orgId: other.id,
          connectorType: 'demo',
          config: { count: 1 },
        },
        headers,
      ),
      await call(
        'POST',
        `/api/v1/connections/${foreignId}/test?orgId=${kit.org.id}`,
        undefined,
        headers,
      ),
      await call(
        'POST',
        `/api/v1/connections/${foreignId}/sync?orgId=${kit.org.id}`,
        undefined,
        headers,
      ),
      await call(
        'POST',
        `/api/v1/connections/${foreignId}/webhook-secret?orgId=${kit.org.id}`,
        undefined,
        headers,
      ),
      await call(
        'PATCH',
        `/api/v1/connections/${foreignId}?orgId=${kit.org.id}`,
        { name: 'Forged' },
        headers,
      ),
      await call(
        'DELETE',
        `/api/v1/connections/${foreignId}?orgId=${kit.org.id}`,
        undefined,
        headers,
      ),
    ];
    // List, create and test-config name the organization (403); by-id routes mask it (404).
    expect(denied.map((response) => response.status)).toEqual([
      403, 403, 404, 404, 403, 403, 404, 404, 404, 404, 404,
    ]);
    expect(await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [foreignId])).toEqual(
      before,
    );
  });

  it('requires an explicit org for list and summary, including Test mode', async () => {
    for (const path of ['/api/v1/connections', '/api/v1/connections/summary']) {
      expect((await call('GET', path)).status).toBe(422);
      expect((await call('GET', `${path}?orgId=`)).status).toBe(422);
      expect(
        (await call('GET', path, undefined, { ...admin(), 'x-passbook-mode': 'test' })).status,
      ).toBe(422);
    }
    const outsider = await makeUser(kit);
    const session = await makeSession(kit, { userId: outsider.id });
    const headers = { ...session.headers, 'x-passbook-mode': 'test' };
    expect(
      (await call('GET', `/api/v1/connections?orgId=${kit.org.id}`, undefined, headers)).status,
    ).toBe(403);
    expect(
      (await call('GET', `/api/v1/connections/summary?orgId=${kit.org.id}`, undefined, headers))
        .status,
    ).toBe(403);
  });
});

describe('scoped API keys', () => {
  it('separates read and write scopes across the complete connection workflow', async () => {
    const writeKey = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
    const readKey = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    const workflow = withWorkflow(kit);
    kit.env.CONNECTION_SYNC = workflow.sctx.env.CONNECTION_SYNC;
    const created = await call(
      'POST',
      '/api/v1/connections',
      {
        orgId: kit.org.id,
        connectorType: 'demo',
        name: 'API source',
        config: { count: 1 },
      },
      writeKey.headers,
    );
    expect(created.status).toBe(201);
    const id = created.json.id as string;

    for (const path of [
      '/api/v1/connections',
      '/api/v1/connections/summary',
      `/api/v1/connections/${id}`,
      `/api/v1/connections/${id}/runs`,
    ]) {
      const denied = await call('GET', path, undefined, writeKey.headers);
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('MISSING_SCOPE');
    }
    const testedConfig = await call(
      'POST',
      '/api/v1/connections/test-config',
      {
        orgId: kit.org.id,
        connectorType: 'demo',
        config: { count: 1 },
      },
      writeKey.headers,
    );
    expect(testedConfig.status).toBe(200);
    expect(testedConfig.json.ok).toBe(true);
    const tested = await call(
      'POST',
      `/api/v1/connections/${id}/test`,
      undefined,
      writeKey.headers,
    );
    expect(tested.status).toBe(200);
    expect(tested.json.ok).toBe(true);
    const updated = await call(
      'PATCH',
      `/api/v1/connections/${id}`,
      {
        name: 'Updated API source',
        config: { count: 2 },
      },
      writeKey.headers,
    );
    expect(updated.status).toBe(200);
    expect(
      await first(kit.env.DB, 'SELECT generation FROM connections WHERE id = ?', [id]),
    ).toEqual({ generation: 2 });
    const sync = await call('POST', `/api/v1/connections/${id}/sync`, undefined, writeKey.headers);
    expect(sync.status).toBe(202);
    expect(workflow.created).toEqual([
      expect.objectContaining({
        id: sync.json.workflowInstanceId,
        params: expect.objectContaining({ orgId: kit.org.id, connectionId: id, generation: 2 }),
      }),
    ]);

    for (const path of ['/api/v1/connections', `/api/v1/connections?orgId=${kit.org.id}`]) {
      const list = await call('GET', path, undefined, readKey.headers);
      expect(list.status).toBe(200);
      expect(list.json.items).toEqual([
        expect.objectContaining({ id, name: 'Updated API source' }),
      ]);
    }
    for (const path of [
      '/api/v1/connections/summary',
      `/api/v1/connections/summary?orgId=${kit.org.id}`,
    ]) {
      const summary = await call('GET', path, undefined, readKey.headers);
      expect(summary.status).toBe(200);
      expect(summary.json.total).toBe(1);
    }
    expect(
      (await call('GET', '/api/v1/connections?orgId=', undefined, readKey.headers)).status,
    ).toBe(422);
    expect(
      (await call('GET', '/api/v1/connections/summary?orgId=', undefined, readKey.headers)).status,
    ).toBe(422);
    expect(
      (await call('GET', `/api/v1/connections/${id}`, undefined, readKey.headers)).status,
    ).toBe(200);
    const runs = await call('GET', `/api/v1/connections/${id}/runs`, undefined, readKey.headers);
    expect(runs.status).toBe(200);
    expect(runs.json.items).toHaveLength(2);

    const before = await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id]);
    for (const [method, path, body] of [
      [
        'POST',
        '/api/v1/connections',
        { orgId: kit.org.id, connectorType: 'demo', name: 'Denied', config: {} },
      ],
      [
        'POST',
        '/api/v1/connections/test-config',
        { orgId: kit.org.id, connectorType: 'demo', config: {} },
      ],
      ['POST', `/api/v1/connections/${id}/test`, undefined],
      ['POST', `/api/v1/connections/${id}/sync`, undefined],
      ['POST', `/api/v1/connections/${id}/webhook-secret`, undefined],
      ['PATCH', `/api/v1/connections/${id}`, { name: 'Denied' }],
      ['DELETE', `/api/v1/connections/${id}`, undefined],
    ] as const) {
      const denied = await call(method, path, body, readKey.headers);
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('MISSING_SCOPE');
    }
    expect(await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id])).toEqual(before);
    expect(
      (await call('DELETE', `/api/v1/connections/${id}`, undefined, writeKey.headers)).status,
    ).toBe(200);
    expect(
      (await call('GET', `/api/v1/connections/${id}`, undefined, readKey.headers)).status,
    ).toBe(404);
  });

  it('encrypts credentials and rotates webhook secrets without leaking key or secret material', async () => {
    const logs: string[] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    const key = await makeApiKey(kit, {
      orgId: kit.org.id,
      scopes: ['connections:read', 'connections:write'],
    });
    const created = await call(
      'POST',
      '/api/v1/connections',
      {
        orgId: kit.org.id,
        connectorType: 'http-json',
        name: 'Secret source',
        config: { baseUrl: 'https://api.example.com/v1' },
        secrets: { token: 'initial-key-secret' },
      },
      key.headers,
    );
    expect(created.status).toBe(201);
    expect(created.text).not.toContain('initial-key-secret');
    const id = created.json.id as string;
    const updated = await call(
      'PATCH',
      `/api/v1/connections/${id}`,
      {
        secrets: { token: 'replacement-key-secret' },
      },
      key.headers,
    );
    expect(updated.status).toBe(200);
    expect(updated.text).not.toContain('replacement-key-secret');
    const storedConnection = await getConnection(kit.env.DB, id);
    if (!storedConnection) throw new Error('Missing API-created connection');
    expect(await readConnectorSecrets(kit.sctx, storedConnection)).toEqual({
      token: 'replacement-key-secret',
    });
    const webhook = await call(
      'POST',
      '/api/v1/connections',
      {
        orgId: kit.org.id,
        connectorType: 'webhook-push',
        name: 'Webhook',
        config: {},
        mode: 'webhook',
      },
      key.headers,
    );
    expect(webhook.status).toBe(201);
    const originalWebhookSecret = webhook.json.webhookSecret as string;
    expect(originalWebhookSecret).toBeTruthy();
    const rotated = await call(
      'POST',
      `/api/v1/connections/${webhook.json.id}/webhook-secret`,
      undefined,
      key.headers,
    );
    expect(rotated.status).toBe(200);
    const replacementWebhookSecret = rotated.json.webhookSecret as string;
    expect(replacementWebhookSecret).toBeTruthy();
    expect(replacementWebhookSecret).not.toBe(originalWebhookSecret);
    const storedWebhook = await getConnection(kit.env.DB, webhook.json.id as string);
    if (!storedWebhook) throw new Error('Missing API-created webhook');
    expect(await readWebhookSecret(kit.sctx, storedWebhook)).toBe(replacementWebhookSecret);
    const detail = await call(
      'GET',
      `/api/v1/connections/${webhook.json.id}`,
      undefined,
      key.headers,
    );
    expect(detail.text).not.toContain(originalWebhookSecret);
    expect(detail.text).not.toContain(replacementWebhookSecret);
    const other = await makeOrg(kit);
    expect(
      (await call('GET', `/api/v1/connections?orgId=${other.id}`, undefined, key.headers)).status,
    ).toBe(403);

    const credentials = await all<{ created_by: string | null; ciphertext: string }>(
      kit.env.DB,
      'SELECT created_by, hex(ciphertext) AS ciphertext FROM credentials WHERE org_id = ?',
      [kit.org.id],
    );
    expect(credentials).toHaveLength(2);
    expect(credentials.every((credential) => credential.created_by === null)).toBe(true);
    for (const secret of ['replacement-key-secret', replacementWebhookSecret]) {
      const rows = await all<{ matches: number }>(
        kit.env.DB,
        'SELECT instr(hex(ciphertext), hex(?)) AS matches FROM credentials WHERE org_id = ?',
        [secret, kit.org.id],
      );
      expect(rows.every((row) => row.matches === 0)).toBe(true);
    }
    const audits = await all<{
      actor_type: string;
      actor_id: string | null;
      detail: string | null;
    }>(kit.env.DB, 'SELECT actor_type, actor_id, detail FROM audit_log WHERE org_id = ?', [
      kit.org.id,
    ]);
    expect(
      audits.some((entry) => entry.actor_type === 'api_key' && entry.actor_id === key.id),
    ).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    const stored = JSON.stringify({ credentials, audits });
    for (const secret of [
      key.secret,
      'initial-key-secret',
      'replacement-key-secret',
      originalWebhookSecret,
      replacementWebhookSecret,
    ]) {
      expect(stored).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain(secret);
    }
  });

  it('logs only INTERNAL when a connector throws key and credential material during tests', async () => {
    const key = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
    const secret = 'connector-error-credential-98765';
    const input = {
      orgId: kit.org.id,
      connectorType: 'http-json',
      config: {
        baseUrl: 'https://api.example.com/v1',
        testRef: 'm-1',
        recordPath: '/members/{ref}',
      },
      secrets: { token: secret },
    };
    const created = await call(
      'POST',
      '/api/v1/connections',
      { ...input, name: 'Failing connector' },
      key.headers,
    );
    expect(created.status).toBe(201);
    const connector = connectors.get('http-json');
    if (!connector) throw new Error('Missing HTTP connector');
    const originalGet = connectors.get.bind(connectors);
    const observed: string[] = [];
    const failing: typeof connector = {
      ...connector,
      test: async (ctx) => {
        observed.push(ctx.secrets.token);
        throw new Error(`Connector failed with ${ctx.secrets.token} and ${key.secret}`);
      },
    };
    vi.spyOn(connectors, 'get').mockImplementation((type) =>
      type === 'http-json' ? failing : originalGet(type),
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saved = await call(
      'POST',
      `/api/v1/connections/${created.json.id}/test`,
      undefined,
      key.headers,
    );
    const unsaved = await call('POST', '/api/v1/connections/test-config', input, key.headers);
    expect(saved.status).toBe(200);
    expect(unsaved.status).toBe(200);
    expect(saved.json).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(unsaved.json).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(observed).toEqual([secret, secret]);
    const logs = errorLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as { event: string; code: string },
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'connection.test_failed', code: 'INTERNAL' }),
        expect.objectContaining({ event: 'connection.test_config_failed', code: 'INTERNAL' }),
      ]),
    );
    const audits = await all(kit.env.DB, 'SELECT detail FROM audit_log WHERE org_id = ?', [
      kit.org.id,
    ]);
    const runs = await all(
      kit.env.DB,
      'SELECT error_code, error_detail FROM connection_runs WHERE connection_id = ?',
      [created.json.id as string],
    );
    const exposed = JSON.stringify({
      logs,
      saved: saved.json,
      unsaved: unsaved.json,
      audits,
      runs,
    });
    expect(exposed).not.toContain(secret);
    expect(exposed).not.toContain(key.secret);
  });

  it('pins lists and every known foreign connection to the key organization', async () => {
    const other = await makeOrg(kit);
    await addMembership(kit, kit.actor.id, ['org_admin'], other.id);
    const own = await create({
      connectorType: 'demo',
      name: 'Own',
      config: {},
      secrets: undefined,
    });
    const foreign = await create({
      orgId: other.id,
      connectorType: 'demo',
      name: 'Foreign',
      config: {},
      secrets: undefined,
    });
    const id = foreign.json.id as string;
    const key = await makeApiKey(kit, {
      orgId: kit.org.id,
      scopes: ['connections:read', 'connections:write'],
    });
    const list = await call('GET', '/api/v1/connections', undefined, key.headers);
    expect(list.status).toBe(200);
    expect(list.json.items).toEqual([expect.objectContaining({ id: own.json.id })]);
    expect(list.text).not.toContain(id);
    const before = await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id]);
    const foreignBefore = await all(
      kit.env.DB,
      'SELECT * FROM connections WHERE org_id = ? ORDER BY id',
      [other.id],
    );
    for (const [method, path, body] of [
      ['GET', `/api/v1/connections?orgId=${other.id}`, undefined],
      ['GET', `/api/v1/connections/summary?orgId=${other.id}`, undefined],
      ['GET', `/api/v1/connections/${id}`, undefined],
      ['GET', `/api/v1/connections/${id}?orgId=${kit.org.id}`, undefined],
      ['GET', `/api/v1/connections/${id}/runs?orgId=${kit.org.id}`, undefined],
      [
        'POST',
        '/api/v1/connections',
        { orgId: other.id, connectorType: 'demo', name: 'Forged', config: {} },
      ],
      [
        'POST',
        '/api/v1/connections/test-config',
        { orgId: other.id, connectorType: 'demo', config: {} },
      ],
      ['POST', `/api/v1/connections/${id}/test?orgId=${kit.org.id}`, undefined],
      ['POST', `/api/v1/connections/${id}/sync?orgId=${kit.org.id}`, undefined],
      ['POST', `/api/v1/connections/${id}/webhook-secret?orgId=${kit.org.id}`, undefined],
      ['PATCH', `/api/v1/connections/${id}?orgId=${kit.org.id}`, { name: 'Forged' }],
      ['DELETE', `/api/v1/connections/${id}?orgId=${kit.org.id}`, undefined],
    ] as const) {
      const byId = /^\/api\/v1\/connections\/(?!summary|test-config)[^/?]+/.test(path);
      expect((await call(method, path, body, key.headers)).status).toBe(byId ? 404 : 403);
    }
    expect(await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM connections WHERE org_id = ? ORDER BY id', [other.id]),
    ).toEqual(foreignBefore);
    expect(
      await first(kit.env.DB, 'SELECT id FROM connection_runs WHERE connection_id = ?', [id]),
    ).toBeNull();
  });

  it('requires an explicit org for platform-key lists and confines each result to that org', async () => {
    const other = await makeOrg(kit);
    const key = await makeApiKey(kit, {
      orgId: null,
      scopes: ['connections:read', 'connections:write'],
    });
    const created = (orgId: string, name: string) =>
      call(
        'POST',
        '/api/v1/connections',
        { orgId, connectorType: 'demo', name, config: {} },
        key.headers,
      );
    const own = await created(kit.org.id, 'First');
    const foreign = await created(other.id, 'Second');
    expect(own.status).toBe(201);
    expect(foreign.status).toBe(201);
    for (const path of ['/api/v1/connections', '/api/v1/connections/summary']) {
      expect((await call('GET', path, undefined, key.headers)).status).toBe(422);
      expect((await call('GET', `${path}?orgId=`, undefined, key.headers)).status).toBe(422);
      expect(
        (await call('GET', `${path}?orgId=${kit.org.id}`, undefined, key.headers)).status,
      ).toBe(200);
      expect((await call('GET', `${path}?orgId=${other.id}`, undefined, key.headers)).status).toBe(
        200,
      );
    }
    const ownList = await call(
      'GET',
      `/api/v1/connections?orgId=${kit.org.id}`,
      undefined,
      key.headers,
    );
    const otherList = await call(
      'GET',
      `/api/v1/connections?orgId=${other.id}`,
      undefined,
      key.headers,
    );
    expect(ownList.json.items).toEqual([expect.objectContaining({ id: own.json.id })]);
    expect(otherList.json.items).toEqual([expect.objectContaining({ id: foreign.json.id })]);
    expect(
      (await call('GET', `/api/v1/connections/${foreign.json.id}`, undefined, key.headers)).status,
    ).toBe(200);
  });

  it.each(['revoked', 'expired'] as const)('rejects a %s persisted key', async (status) => {
    const key = await makeApiKey(kit, {
      orgId: kit.org.id,
      scopes: ['connections:read', 'connections:write'],
    });
    // Expiry is time passing; the key's identity columns are otherwise immutable (0039).
    await (status === 'revoked' ? run : editApiKeyIdentity)(
      kit.env.DB,
      `UPDATE api_keys SET ${status === 'revoked' ? 'revoked_at' : 'expires_at'} = ? WHERE id = ?`,
      [kit.clock.now(), key.id],
    );
    expect((await call('GET', '/api/v1/connections', undefined, key.headers)).status).toBe(401);
    expect(
      (
        await call(
          'POST',
          '/api/v1/connections',
          {
            orgId: kit.org.id,
            connectorType: 'demo',
            name: 'Denied',
            config: {},
          },
          key.headers,
        )
      ).status,
    ).toBe(401);
    expect(
      await first(kit.env.DB, 'SELECT id FROM connections WHERE org_id = ?', [kit.org.id]),
    ).toBeNull();
  });

  it('uses the persisted key mode, not the session mode header', async () => {
    const liveKey = await makeApiKey(kit, {
      orgId: kit.org.id,
      scopes: ['connections:read', 'connections:write'],
    });
    const testKey = await makeApiKey(kit, {
      orgId: kit.org.id,
      scopes: ['connections:read', 'connections:write'],
      mode: 'test',
    });
    const created = await call(
      'POST',
      '/api/v1/connections',
      {
        orgId: kit.org.id,
        connectorType: 'demo',
        name: 'Live',
        config: { count: 1 },
      },
      { ...liveKey.headers, 'x-passbook-mode': 'test' },
    );
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const headers = { ...testKey.headers, 'x-passbook-mode': 'live' };
    expect((await call('GET', '/api/v1/connections', undefined, headers)).json).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await call('GET', '/api/v1/connections/summary', undefined, headers)).json).toEqual({
      total: 0,
      byHealth: {},
      attention: [],
    });
    const before = await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id]);
    for (const [method, path, body] of [
      ['GET', `/api/v1/connections/${id}`, undefined],
      ['GET', `/api/v1/connections/${id}/runs`, undefined],
      [
        'POST',
        '/api/v1/connections',
        { orgId: kit.org.id, connectorType: 'demo', name: 'Denied', config: {} },
      ],
      [
        'POST',
        '/api/v1/connections/test-config',
        { orgId: kit.org.id, connectorType: 'demo', config: {} },
      ],
      ['POST', `/api/v1/connections/${id}/test`, undefined],
      ['POST', `/api/v1/connections/${id}/sync`, undefined],
      ['POST', `/api/v1/connections/${id}/webhook-secret`, undefined],
      ['PATCH', `/api/v1/connections/${id}`, { name: 'Denied' }],
      ['DELETE', `/api/v1/connections/${id}`, undefined],
    ] as const) {
      const denied = await call(method, path, body, headers);
      expect(denied.status).toBe(404);
      expect(denied.json.code).toBe('CONNECTION_NOT_FOUND');
    }
    expect(await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id])).toEqual(before);
    expect(
      (await call('GET', `/api/v1/connections/${id}`, undefined, liveKey.headers)).status,
    ).toBe(200);
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

describe('connector registry authorization', () => {
  it.each(['integration_admin', 'read_only'] as const)(
    'allows a non-admin %s member to read the catalog for their organization',
    async (role) => {
      const user = await makeUser(kit);
      await addMembership(kit, user.id, [role]);
      const session = await makeSession(kit, { userId: user.id });
      const list = await call(
        'GET',
        `/api/v1/connectors?orgId=${kit.org.id}`,
        undefined,
        session.headers,
      );
      expect(list.status).toBe(200);
      expect(list.json.items.map((connector: { type: string }) => connector.type).sort()).toEqual([
        'demo',
        'http-json',
        'webhook-push',
      ]);
      const detail = await call(
        'GET',
        `/api/v1/connectors/demo?orgId=${kit.org.id}`,
        undefined,
        session.headers,
      );
      expect(detail.status).toBe(200);
      expect(detail.json.type).toBe('demo');
      const missing = await call(
        'GET',
        `/api/v1/connectors/nope?orgId=${kit.org.id}`,
        undefined,
        session.headers,
      );
      expect(missing.status).toBe(404);
      expect(missing.json.code).toBe('CONNECTOR_NOT_FOUND');
      for (const path of ['/api/v1/connectors', '/api/v1/connectors/demo']) {
        const unscoped = await call('GET', path, undefined, session.headers);
        expect(unscoped.status).toBe(422);
        expect(unscoped.json.code).toBe('VALIDATION');
      }
    },
  );

  it('denies a member without the integrations read capability', async () => {
    const user = await makeUser(kit);
    await addMembership(kit, user.id, ['template_author']);
    const session = await makeSession(kit, { userId: user.id });
    for (const path of ['/api/v1/connectors', '/api/v1/connectors/demo']) {
      expect(
        (await call('GET', `${path}?orgId=${kit.org.id}`, undefined, session.headers)).status,
      ).toBe(403);
    }
  });

  it('rejects explicit scopes without membership, including for platform administrators', async () => {
    const other = await makeOrg(kit);
    const member = await makeUser(kit);
    await addMembership(kit, member.id, ['integration_admin']);
    const memberSession = await makeSession(kit, { userId: member.id });
    const outsider = await makeUser(kit);
    const outsiderSession = await makeSession(kit, { userId: outsider.id });
    const platformUser = await makeUser(kit);
    const platformAdmin = await makeSession(kit, {
      userId: platformUser.id,
      roles: ['admin', 'user'],
    });
    for (const path of ['/api/v1/connectors', '/api/v1/connectors/demo']) {
      expect(
        (await call('GET', `${path}?orgId=${kit.org.id}`, undefined, outsiderSession.headers))
          .status,
      ).toBe(403);
      expect(
        (await call('GET', `${path}?orgId=${kit.org.id}`, undefined, platformAdmin.headers)).status,
      ).toBe(403);
      expect(
        (await call('GET', `${path}?orgId=${other.id}`, undefined, memberSession.headers)).status,
      ).toBe(403);
      expect(
        (await call('GET', `${path}?orgId=forged-org`, undefined, memberSession.headers)).status,
      ).toBe(403);
      expect((await app.request(`${path}?orgId=${kit.org.id}`, {}, kit.env)).status).toBe(401);
    }
  });

  it('authorizes explicitly scoped API keys by read scope and organization', async () => {
    const other = await makeOrg(kit);
    const bound = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:read'] });
    const platform = await makeApiKey(kit, { orgId: null, scopes: ['connections:read'] });
    const writeOnly = await makeApiKey(kit, { orgId: kit.org.id, scopes: ['connections:write'] });
    const testKey = await makeApiKey(kit, {
      orgId: kit.org.id,
      scopes: ['connections:read'],
      mode: 'test',
    });
    for (const path of ['/api/v1/connectors', '/api/v1/connectors/demo']) {
      for (const key of [bound, platform]) {
        expect((await call('GET', path, undefined, key.headers)).status).toBe(422);
      }
      const unscopedWriteOnly = await call('GET', path, undefined, writeOnly.headers);
      expect(unscopedWriteOnly.status).toBe(403);
      expect(unscopedWriteOnly.json.code).toBe('MISSING_SCOPE');
      expect(
        (await call('GET', `${path}?orgId=${kit.org.id}`, undefined, bound.headers)).status,
      ).toBe(200);
      const live = await call('GET', `${path}?orgId=${kit.org.id}`, undefined, bound.headers);
      const test = await call('GET', `${path}?orgId=${kit.org.id}`, undefined, {
        ...testKey.headers,
        'x-passbook-mode': 'live',
      });
      expect(test.status).toBe(200);
      expect(test.json).toEqual(live.json);
      expect(
        (await call('GET', `${path}?orgId=${other.id}`, undefined, bound.headers)).status,
      ).toBe(403);
      expect(
        (await call('GET', `${path}?orgId=${kit.org.id}`, undefined, platform.headers)).status,
      ).toBe(200);
      expect(
        (await call('GET', `${path}?orgId=${other.id}`, undefined, platform.headers)).status,
      ).toBe(200);
      const denied = await call('GET', `${path}?orgId=${kit.org.id}`, undefined, writeOnly.headers);
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('MISSING_SCOPE');
    }
  });

  it('retains unscoped platform-admin access', async () => {
    const platformUser = await makeUser(kit);
    const platformAdmin = await makeSession(kit, {
      userId: platformUser.id,
      roles: ['admin', 'user'],
    });
    expect((await call('GET', '/api/v1/connectors', undefined, platformAdmin.headers)).status).toBe(
      200,
    );
    expect(
      (await call('GET', '/api/v1/connectors/demo', undefined, platformAdmin.headers)).status,
    ).toBe(200);
    expect(
      (
        await call(
          'GET',
          `/api/v1/connections?orgId=${kit.org.id}`,
          undefined,
          platformAdmin.headers,
        )
      ).status,
    ).toBe(403);
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

  it('pages the list by cursor without repeats or gaps', async () => {
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C']) ids.push((await create({ name })).json.id as string);
    const list = (cursor?: string) =>
      call(
        'GET',
        `/api/v1/connections?orgId=${kit.org.id}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
    const one = await list();
    expect(one.json.items).toHaveLength(2);
    expect(one.json.nextCursor).toEqual(expect.any(String));
    const two = await list(one.json.nextCursor as string);
    expect(two.json.nextCursor).toBeNull();
    const seen = [...one.json.items, ...two.json.items].map((c: { id: string }) => c.id);
    expect([...seen].sort()).toEqual([...ids].sort());
    // Newest first, the same order as the first page.
    expect(seen).toEqual([...seen].sort().reverse());
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
    const other = await makeOrg(kit);
    await addMembership(kit, kit.actor.id, ['org_admin'], other.id);
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
    const summary = await call('GET', `/api/v1/connections/summary?orgId=${kit.org.id}`);
    expect(summary.status).toBe(200);
    expect(summary.json.total).toBeGreaterThanOrEqual(1);
  });

  it('keeps Live connection data and operations unavailable in Test mode', async () => {
    const created = await call('POST', '/api/v1/connections', {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Live source',
      config: { count: 1 },
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const before = await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id]);
    const headers = { ...admin(), 'x-passbook-mode': 'test' };
    expect(
      (await call('GET', `/api/v1/connections?orgId=${kit.org.id}`, undefined, headers)).json,
    ).toEqual({ items: [], nextCursor: null });
    expect(
      (await call('GET', `/api/v1/connections/summary?orgId=${kit.org.id}`, undefined, headers))
        .json,
    ).toEqual({ total: 0, byHealth: {}, attention: [] });
    const denied = [
      await call('GET', `/api/v1/connections/${id}`, undefined, headers),
      await call('GET', `/api/v1/connections/${id}/runs`, undefined, headers),
      await call('POST', `/api/v1/connections/${id}/test`, undefined, headers),
      await call('POST', `/api/v1/connections/${id}/sync`, undefined, headers),
      await call('POST', `/api/v1/connections/${id}/webhook-secret`, undefined, headers),
      await call('PATCH', `/api/v1/connections/${id}`, { name: 'Forbidden' }, headers),
      await call('DELETE', `/api/v1/connections/${id}`, undefined, headers),
      await call(
        'POST',
        '/api/v1/connections',
        {
          orgId: kit.org.id,
          connectorType: 'demo',
          name: 'Forbidden',
          config: { count: 1 },
        },
        headers,
      ),
      await call(
        'POST',
        '/api/v1/connections/test-config',
        {
          orgId: kit.org.id,
          connectorType: 'demo',
          config: { count: 1 },
        },
        headers,
      ),
    ];
    for (const response of denied) {
      expect(response.status).toBe(404);
      expect(response.json.code).toBe('CONNECTION_NOT_FOUND');
    }
    expect(await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [id])).toEqual(before);
    expect(
      await first(kit.env.DB, 'SELECT id FROM connection_runs WHERE connection_id = ?', [id]),
    ).toBeNull();
    expect((await call('GET', '/api/v1/connectors', undefined, headers)).status).toBe(200);
    expect((await call('GET', `/api/v1/connections/${id}`)).status).toBe(200);
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
    await seedConnectionWorkflow(kit.sctx, {
      connectionId: id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      trigger: 'admin',
      runId: 'wf-instance-1',
      instanceId: 'wf-instance-1',
    });
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
        payload: {
          connectionId: id,
          orgId: kit.org.id,
          generation: 1,
          trigger: 'admin',
          credentialKeysetCommitment: kit.credentialKeysetCommitment,
        },
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
