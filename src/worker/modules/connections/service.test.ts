import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makeTemplate, persistTemplate } from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { ValidationError } from '../../platform/errors.ts';
import * as actions from './actions.ts';
import { setDeps } from './deps.ts';
import { getConnection } from './repo.ts';
import { readConnectorSecrets, readWebhookSecret } from './secrets.ts';
import * as service from './service.ts';
import { createDemo, demoInput, type Kit, linkedPass, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

const httpJson = (over: Record<string, unknown> = {}) =>
  demoInput(kit, {
    connectorType: 'http-json',
    name: 'Members API',
    config: { baseUrl: 'https://api.example.com/v1' },
    secrets: { token: 'tok-super-secret-123' },
    ...over,
  } as never);

const creds = async (kind = '%') =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM credentials WHERE org_id = ? AND kind LIKE ?',
      [kit.org.id, kind],
    )
  )?.n;

const audit = (action: string) =>
  all<{ detail: string | null; actor_id: string | null; org_id: string | null }>(
    kit.env.DB,
    'SELECT detail, actor_id, org_id FROM audit_log WHERE action = ? AND org_id = ?',
    [action, kit.org.id],
  );

describe('create', () => {
  it('stores a demo connection with defaults and schedules it', async () => {
    const dto = await createDemo(kit);
    expect(dto).toMatchObject({
      orgId: kit.org.id,
      connectorType: 'demo',
      mode: 'poll',
      enabled: true,
      health: 'unknown',
      hasCredential: false,
      hasWebhookSecret: false,
      autoCreate: false,
      autoEmail: false,
      onMissing: 'flag',
      webhookUrl: null,
      nextRunAt: kit.clock.now(),
    });
    expect(dto.config).toMatchObject({ count: 3, seed: 'demo' });
    expect(dto.webhookSecret).toBeUndefined();
  });

  it('keeps manual connections off the schedule', async () => {
    expect((await createDemo(kit, { mode: 'manual' })).nextRunAt).toBeNull();
  });

  it('never returns or stores secrets in plaintext, and records a fingerprint', async () => {
    const dto = await service.create(kit.sctx, kit.actor, httpJson());
    expect(dto.hasCredential).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('tok-super-secret');
    const detail = await service.getDetail(kit.sctx, dto.id);
    expect(JSON.stringify(detail)).not.toContain('tok-super-secret');
    const list = await service.listAll(kit.sctx, { limit: 50 });
    expect(JSON.stringify(list)).not.toContain('tok-super-secret');

    const row = await first<{ ciphertext: ArrayBuffer; fingerprint: string; kind: string }>(
      kit.env.DB,
      'SELECT c.ciphertext, c.fingerprint, c.kind FROM credentials c JOIN connections n ON n.credential_id = c.id WHERE n.id = ?',
      [dto.id],
    );
    expect(row?.kind).toBe('connector');
    expect(row?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(
      new TextDecoder().decode(new Uint8Array(row?.ciphertext as unknown as number[])),
    ).not.toContain('tok-super-secret');

    const conn = await getConnection(kit.env.DB, dto.id);
    expect(conn && (await readConnectorSecrets(kit.sctx, conn))).toEqual({
      token: 'tok-super-secret-123',
    });
    const logs = JSON.stringify(await audit('connection.create'));
    expect(logs).not.toContain('tok-super-secret');
  });

  it('binds credentials to the org (a row moved to another org will not decrypt)', async () => {
    const dto = await service.create(kit.sctx, kit.actor, httpJson());
    const other = await makeOrg(kit);
    await kit.env.DB.prepare(
      'UPDATE credentials SET org_id = ? WHERE id = (SELECT credential_id FROM connections WHERE id = ?)',
    )
      .bind(other.id, dto.id)
      .run();
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('missing');
    // Same connection row, credential now owned by another org: lookup by org finds nothing.
    expect(await readConnectorSecrets(kit.sctx, conn)).toBeUndefined();
  });

  it('generates a webhook secret once for webhook modes', async () => {
    const dto = await service.create(
      kit.sctx,
      kit.actor,
      demoInput(kit, { connectorType: 'webhook-push', config: {}, mode: 'webhook' }),
    );
    expect(dto.webhookSecret).toMatch(/^whsec_/);
    expect(dto.hasWebhookSecret).toBe(true);
    expect(dto.webhookUrl).toBe(
      `${kit.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/hooks/connections/${dto.id}`,
    );
    const conn = await getConnection(kit.env.DB, dto.id);
    expect(conn && (await readWebhookSecret(kit.sctx, conn))).toBe(dto.webhookSecret);
    const again = await service.getDetail(kit.sctx, dto.id);
    expect(JSON.stringify(again)).not.toContain(dto.webhookSecret ?? 'x');
  });

  it('does not echo a webhook secret the admin supplied', async () => {
    const dto = await service.create(
      kit.sctx,
      kit.actor,
      demoInput(kit, {
        connectorType: 'webhook-push',
        config: {},
        mode: 'webhook',
        webhookSecret: 'my-own-secret-0123456789',
      }),
    );
    expect(dto.webhookSecret).toBeUndefined();
    const conn = await getConnection(kit.env.DB, dto.id);
    expect(conn && (await readWebhookSecret(kit.sctx, conn))).toBe('my-own-secret-0123456789');
  });

  it('rejects invalid input', async () => {
    const bad: [string, Parameters<typeof demoInput>[1]][] = [
      ['unknown connector', { connectorType: 'nope' }],
      ['invalid config', { config: { count: 'many' } }],
      ['mode the connector lacks', { mode: 'webhook' }],
      ['hybrid on a poll-only connector', { mode: 'hybrid' }],
      ['secrets on a connector without any', { secrets: { a: 'b' } }],
      ['webhook secret on a connector without webhooks', { webhookSecret: 'x'.repeat(20) }],
      ['bad mapping', { mapping: { a: { from: '/x~2' } } }],
      ['bad holder pointer', { holderEmailField: '/a~9' }],
      ['auto-create without template', { autoCreate: true }],
      ['unknown template', { defaultTemplateId: 'nope' }],
      ['unknown org', { orgId: 'no-such-org' }],
    ];
    for (const [name, over] of bad) {
      await expect(createDemo(kit, over), name).rejects.toBeInstanceOf(ValidationError);
    }
    const count = await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM connections WHERE org_id = ?',
      [kit.org.id],
    );
    expect(count?.n).toBe(0);
  });

  it('reports invalid secrets by field', async () => {
    const err = await service
      .create(kit.sctx, kit.actor, httpJson({ secrets: { token: 5 } }))
      .catch((e: ValidationError) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues?.[0]?.path).toBe('secrets.token');
  });

  it('refuses another org template', async () => {
    const other = await makeOrg(kit);
    const template = makeTemplate({ id: 'tpl-other-org', orgId: other.id });
    await persistTemplate(kit, template.resolved);
    await expect(
      createDemo(kit, { defaultTemplateId: 'tpl-other-org', autoCreate: true }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    const ok = await createDemo(kit, { defaultTemplateId: kit.templateId, autoCreate: true });
    expect(ok.autoCreate).toBe(true);
  });

  it('writes an audit entry without secrets', async () => {
    const dto = await service.create(kit.sctx, kit.actor, httpJson());
    const rows = await audit('connection.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: kit.actor.id, org_id: kit.org.id });
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({
      connectorType: 'http-json',
      mode: 'poll',
    });
    expect(dto.id).toBeTruthy();
  });
});

describe('SSRF at save', () => {
  it.each([
    'http://api.example.com/v1',
    'https://127.0.0.1/v1',
    'https://[::1]/v1',
    'https://localhost/v1',
    'https://intranet/v1',
    'https://api.example.com:8443/v1',
    'https://user:pw@api.example.com/v1',
    'https://wallet.plrs.im/v1',
    'https://thing.workers.dev/v1',
  ])('rejects %s', async (baseUrl) => {
    await expect(
      service.create(kit.sctx, kit.actor, httpJson({ config: { baseUrl } })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects hosts that resolve to private addresses or nowhere', async () => {
    setDeps({ resolver: { resolve: async () => ['10.0.0.5'] } });
    await expect(service.create(kit.sctx, kit.actor, httpJson())).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    });
    setDeps({ resolver: { resolve: async () => ['93.184.216.34', '192.168.1.1'] } });
    await expect(service.create(kit.sctx, kit.actor, httpJson())).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    });
    setDeps({ resolver: { resolve: async () => [] } });
    await expect(service.create(kit.sctx, kit.actor, httpJson())).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    });
  });

  it('checks again when the config is edited', async () => {
    const dto = await service.create(kit.sctx, kit.actor, httpJson());
    await expect(
      service.update(kit.sctx, kit.actor, dto.id, {
        config: { baseUrl: 'https://169.254.169.254' },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    const stored = await getConnection(kit.env.DB, dto.id);
    expect(stored?.config.baseUrl).toBe('https://api.example.com/v1');
  });
});

describe('update', () => {
  it('bumps the generation and resets the cursor on config, secret and mapping changes only', async () => {
    const dto = await service.create(kit.sctx, kit.actor, httpJson());
    await kit.env.DB.prepare("UPDATE connections SET cursor = 'abc' WHERE id = ?")
      .bind(dto.id)
      .run();

    await service.update(kit.sctx, kit.actor, dto.id, { name: 'Renamed', intervalSeconds: 120 });
    let row = await getConnection(kit.env.DB, dto.id);
    expect([row?.generation, row?.cursor, row?.name]).toEqual([1, 'abc', 'Renamed']);

    await service.update(kit.sctx, kit.actor, dto.id, { mapping: { memberName: { from: '/n' } } });
    row = await getConnection(kit.env.DB, dto.id);
    expect(row?.generation).toBe(2);

    await service.update(kit.sctx, kit.actor, dto.id, {
      secrets: { token: 'rotated-token-value' },
    });
    row = await getConnection(kit.env.DB, dto.id);
    expect([row?.generation, row?.cursor]).toEqual([3, null]);
    expect(row && (await readConnectorSecrets(kit.sctx, row))).toEqual({
      token: 'rotated-token-value',
    });

    await service.update(kit.sctx, kit.actor, dto.id, {
      config: { baseUrl: 'https://api.example.com/v2' },
    });
    row = await getConnection(kit.env.DB, dto.id);
    expect(row?.generation).toBe(4);
  });

  it('replaces credentials without leaving the old row behind', async () => {
    const dto = await service.create(kit.sctx, kit.actor, httpJson());
    await service.update(kit.sctx, kit.actor, dto.id, { secrets: { token: 'second-token-value' } });
    expect(await creds()).toBe(1);
    const cleared = await service.update(kit.sctx, kit.actor, dto.id, { secrets: {} });
    expect(cleared.hasCredential).toBe(false);
    expect(await creds()).toBe(0);
  });

  it('disables and re-enables, clearing the breaker', async () => {
    const dto = await createDemo(kit);
    await kit.env.DB.prepare(
      'UPDATE connections SET consecutive_failures = 7, breaker_open_until = ?, health = ? WHERE id = ?',
    )
      .bind(kit.clock.now() + 3_600_000, 'failing', dto.id)
      .run();
    const off = await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    expect(off).toMatchObject({ enabled: false, health: 'disabled', nextRunAt: null });
    const on = await service.update(kit.sctx, kit.actor, dto.id, { enabled: true });
    expect(on).toMatchObject({
      enabled: true,
      health: 'unknown',
      consecutiveFailures: 0,
      breakerOpenUntil: null,
      nextRunAt: kit.clock.now(),
    });
  });

  it('generates a webhook secret when the mode starts needing one', async () => {
    const dto = await service.create(
      kit.sctx,
      kit.actor,
      demoInput(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com' },
        mode: 'manual',
      }),
    );
    expect(dto.hasWebhookSecret).toBe(false);
    const hybrid = await service.update(kit.sctx, kit.actor, dto.id, { mode: 'hybrid' });
    expect(hybrid.webhookSecret).toMatch(/^whsec_/);
    expect(hybrid.nextRunAt).toBe(kit.clock.now());
    const again = await service.update(kit.sctx, kit.actor, dto.id, { name: 'x' });
    expect(again.webhookSecret).toBeUndefined();
  });

  it('rotates the webhook secret and shows it once', async () => {
    const dto = await service.create(
      kit.sctx,
      kit.actor,
      demoInput(kit, { connectorType: 'webhook-push', config: {}, mode: 'webhook' }),
    );
    const rotated = await actions.rotateWebhookSecret(kit.sctx, kit.actor, dto.id);
    expect(rotated.webhookSecret).not.toBe(dto.webhookSecret);
    const conn = await getConnection(kit.env.DB, dto.id);
    expect(conn && (await readWebhookSecret(kit.sctx, conn))).toBe(rotated.webhookSecret);
    expect(await creds('webhook')).toBe(1);
  });

  it('audits every mutation with field names only', async () => {
    const dto = await service.create(kit.sctx, kit.actor, httpJson());
    await service.update(kit.sctx, kit.actor, dto.id, {
      secrets: { token: 'another-secret-xyz' },
      name: 'n',
    });
    await actions.syncNow(withWorkflow(kit).sctx, kit.actor, dto.id);
    await service.remove(kit.sctx, kit.actor, dto.id);
    const rows = await all<{ action: string; detail: string | null }>(
      kit.env.DB,
      'SELECT action, detail FROM audit_log WHERE org_id = ? ORDER BY id',
      [kit.org.id],
    );
    const actionsSeen = rows.map((r) => r.action);
    expect(actionsSeen).toEqual(
      expect.arrayContaining(['connection.create', 'connection.update', 'connection.delete']),
    );
    expect(JSON.stringify(rows)).not.toContain('another-secret-xyz');
    expect(JSON.stringify(rows)).not.toContain('tok-super-secret');
    const upd = rows.find((r) => r.action === 'connection.update');
    expect(JSON.parse(upd?.detail ?? '{}').changed.sort()).toEqual(['name', 'secrets']);
  });
});

describe('delete and isolation', () => {
  it('removes credentials and unlinks passes', async () => {
    const dto = await service.create(kit.sctx, kit.actor, httpJson());
    const pass = await linkedPass(kit, dto.id, 'r1');
    await service.remove(kit.sctx, kit.actor, dto.id);
    expect(await getConnection(kit.env.DB, dto.id)).toBeNull();
    expect(await creds()).toBe(0);
    const row = await first<{ connection_id: string | null }>(
      kit.env.DB,
      'SELECT connection_id FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.connection_id).toBeNull();
  });

  it('lists by org and 404s unknown ids', async () => {
    const other = await makeOrg(kit);
    await createDemo(kit);
    const theirs = await createDemo(kit, { orgId: other.id, name: 'Theirs' });
    const mine = await service.listAll(kit.sctx, { orgId: kit.org.id, limit: 50 });
    expect(mine.items.map((c) => c.orgId)).toEqual([kit.org.id]);
    const everyone = await service.listAll(kit.sctx, { limit: 200 });
    expect(everyone.items.map((c) => c.orgId)).toEqual(
      expect.arrayContaining([kit.org.id, other.id]),
    );
    expect(JSON.stringify(mine)).not.toContain(theirs.id);
    await expect(service.getDetail(kit.sctx, 'missing')).rejects.toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
    });
  });

  it('pages with a cursor', async () => {
    for (const name of ['a', 'b', 'c']) await createDemo(kit, { name });
    const first = await service.listAll(kit.sctx, { orgId: kit.org.id, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await service.listAll(kit.sctx, {
      orgId: kit.org.id,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe('test and sync now', () => {
  it('tests the demo connector, recording a test run and leaving health alone', async () => {
    const dto = await createDemo(kit);
    const ok = await actions.test(kit.sctx, kit.actor, dto.id);
    expect(ok).toMatchObject({ ok: true });
    const bad = await service.update(kit.sctx, kit.actor, dto.id, {
      config: { count: 3, fail: 'auth' },
    });
    kit.clock.advance(5);
    const res = await actions.test(kit.sctx, kit.actor, bad.id);
    expect(res).toMatchObject({ ok: false, errorCode: 'AUTH' });
    const runs = await actions.runs(kit.sctx, dto.id, { limit: 10 });
    expect(runs.items.map((r) => [r.trigger, r.outcome, r.errorCode])).toEqual([
      ['test', 'error', 'AUTH'],
      ['test', 'unchanged', null],
    ]);
    const after = await getConnection(kit.env.DB, dto.id);
    expect(after?.health).toBe('unknown');
  });

  it('starts a sync once per window and refuses disabled connections', async () => {
    const { sctx, created } = withWorkflow(kit);
    const dto = await createDemo(kit);
    const a = await actions.syncNow(sctx, kit.actor, dto.id);
    const b = await actions.syncNow(sctx, kit.actor, dto.id);
    expect(a).toEqual(b);
    expect(a.runId).toBe(a.workflowInstanceId);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      id: a.workflowInstanceId,
      params: { connectionId: dto.id, trigger: 'admin', generation: 1 },
    });
    await service.update(sctx, kit.actor, dto.id, { enabled: false });
    await expect(actions.syncNow(sctx, kit.actor, dto.id)).rejects.toMatchObject({
      code: 'CONNECTION_DISABLED',
    });
  });

  it('summarizes health', async () => {
    const dto = await createDemo(kit);
    await kit.env.DB.prepare(
      "UPDATE connections SET health = 'failing', last_error_code = 'AUTH', last_error_at = 5 WHERE id = ?",
    )
      .bind(dto.id)
      .run();
    await createDemo(kit, { name: 'fine' });
    const s = await actions.healthSummary(kit.sctx);
    expect(s.total).toBeGreaterThanOrEqual(2);
    expect(s.byHealth.failing).toBeGreaterThanOrEqual(1);
    expect(s.attention.map((a) => a.id)).toContain(dto.id);
    expect(s.attention.find((a) => a.id === dto.id)).toMatchObject({ lastErrorCode: 'AUTH' });
  });
});
