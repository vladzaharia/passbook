import { beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { setDeps } from './deps.ts';
import { dailyConnections, RUN_RETENTION_MS } from './jobs.ts';
import { getConnection, listDueConnections } from './repo.ts';
import { listRuns } from './repo-runs.ts';
import { reconcileConnections } from './schedule.ts';
import * as service from './service.ts';
import { dueRefs, runRefs } from './sync.ts';
import { executeSync } from './sync-runner.ts';
import { createDemo, inlineStep, type Kit, linkedPass, makeKit, withWorkflow } from './test-kit.ts';
import { processWebhook, receiveWebhook } from './webhooks.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

const job = (connectionId: string, refs: string[]) => ({
  kind: 'connection.webhook' as const,
  connectionId,
  orgId: kit.org.id,
  generation: 1,
  eventId: 'evt',
  refs,
});

async function signed(secret: string, text: string) {
  const ts = Math.floor(kit.clock.now() / 1000);
  return new Request('https://wallet.test/h', {
    method: 'POST',
    body: text,
    headers: {
      'x-wallet-timestamp': String(ts),
      'x-wallet-signature': await signWebhook(secret, ts, text),
    },
  });
}

describe('stuck runs', () => {
  it('leaves a long run that is still going alone', async () => {
    const dto = await createDemo(kit);
    const { sctx, created } = withWorkflow(kit, undefined, () => 'running');
    await reconcileConnections(sctx);
    expect(created).toHaveLength(1);
    kit.clock.advance(45 * 60_000);
    await reconcileConnections({ ...sctx, clock: kit.clock });
    expect(created).toHaveLength(1);
    expect((await getConnection(kit.env.DB, dto.id))?.lastErrorCode).toBeNull();
  });

  it('replaces an errored instance and marks it', async () => {
    const dto = await createDemo(kit);
    const { sctx } = withWorkflow(kit, undefined, () => 'errored');
    await reconcileConnections(sctx);
    kit.clock.advance(45 * 60_000);
    await reconcileConnections({ ...sctx, clock: kit.clock });
    expect((await getConnection(kit.env.DB, dto.id))?.lastErrorCode).toBe('RUN_LOST');
    const wf = await first<{ status: string }>(
      kit.env.DB,
      'SELECT status FROM workflow_runs WHERE target_id = ?',
      [dto.id],
    );
    expect(wf?.status).toBe('errored');
  });

  it('writes the tracking rows before creating the instance', async () => {
    const dto = await createDemo(kit);
    let seen = 0;
    const { sctx } = withWorkflow(kit, async () => {
      seen = (await all(kit.env.DB, 'SELECT 1 FROM workflow_runs WHERE target_id = ?', [dto.id]))
        .length;
    });
    await reconcileConnections(sctx);
    expect(seen).toBe(1);
  });
});

describe('workflow bookkeeping', () => {
  it('ends complete and prunes old rows daily', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const insert =
      "INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at) VALUES (?, 'connection_sync', ?, ?, ?, ?)";
    await run(kit.env.DB, insert, [
      'wf-old',
      kit.org.id,
      dto.id,
      'complete',
      kit.clock.now() - RUN_RETENTION_MS - 1,
    ]);
    await run(kit.env.DB, insert, ['wf-new', kit.org.id, dto.id, 'queued', kit.clock.now()]);
    await executeSync(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule',
      runId: 'wf-new',
      instanceId: 'wf-new',
    });
    const row = await first<{ status: string }>(
      kit.env.DB,
      "SELECT status FROM workflow_runs WHERE instance_id = 'wf-new'",
    );
    expect(row?.status).toBe('complete');
    await dailyConnections(kit.sctx);
    const left = await all<{ instance_id: string }>(
      kit.env.DB,
      'SELECT instance_id FROM workflow_runs WHERE target_id = ?',
      [dto.id],
    );
    expect(left.map((r) => r.instance_id)).toEqual(['wf-new']);
  });

  it('records an errored workflow when the run dies', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    await run(
      kit.env.DB,
      "INSERT INTO workflow_runs (instance_id, kind, org_id, target_id, status, started_at) VALUES ('wf-x', 'connection_sync', ?, ?, 'queued', ?)",
      [kit.org.id, dto.id, kit.clock.now()],
    );
    const step = inlineStep();
    const failing = {
      ...step,
      do: async (name: string, fn: () => Promise<unknown>) => {
        if (name === 'limits') throw new Error('step exhausted');
        return step.do(name, fn as never);
      },
    };
    await expect(
      executeSync(kit.sctx, failing as never, {
        connectionId: dto.id,
        orgId: kit.org.id,
        generation: 1,
        trigger: 'schedule',
        runId: 'wf-x',
        instanceId: 'wf-x',
      }),
    ).rejects.toThrow('step exhausted');
    const wf = await first<{ status: string; error_code: string }>(
      kit.env.DB,
      "SELECT status, error_code FROM workflow_runs WHERE instance_id = 'wf-x'",
    );
    expect(wf).toEqual({ status: 'errored', error_code: 'INTERNAL' });
  });
});

describe('list pacing', () => {
  it('splits pages into slices and sleeps between list calls', async () => {
    const dto = await createDemo(kit, { config: { count: 25 } });
    const step = inlineStep();
    await executeSync(kit.sctx, step, {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule',
      runId: 'r-pace',
      instanceId: 'r-pace',
    });
    expect(step.names.filter((n) => /^page-\d+$/.test(n))).toHaveLength(3);
    expect(step.sleeps).toHaveLength(2);
  });
});

describe('webhook runs', () => {
  it('do not push the poll schedule forward in hybrid mode', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    await run(kit.env.DB, "UPDATE connections SET mode = 'hybrid', next_run_at = ? WHERE id = ?", [
      kit.clock.now() + 1000,
      dto.id,
    ]);
    await processWebhook(kit.sctx, job(dto.id, ['m-001']));
    const conn = await getConnection(kit.env.DB, dto.id);
    expect(conn?.nextRunAt).toBe(kit.clock.now() + 1000);
    expect(conn?.lastSuccessAt).toBe(kit.clock.now());
  });

  it('throw on transient upstream failures so the queue retries', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'upstream' } });
    await expect(processWebhook(kit.sctx, job(dto.id, ['m-001']))).rejects.toMatchObject({
      code: 'WEBHOOK_UPSTREAM',
    });
    expect((await getConnection(kit.env.DB, dto.id))?.consecutiveFailures).toBe(1);
  });

  it('do not retry permanent auth failures', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'auth' } });
    await processWebhook(kit.sctx, job(dto.id, ['m-001']));
    expect((await getConnection(kit.env.DB, dto.id))?.lastErrorCode).toBe('AUTH');
  });

  it('are queued in jobs of at most 20 refs', async () => {
    const pushed = await createDemo(kit, {
      connectorType: 'webhook-push',
      config: {},
      mode: 'webhook',
    } as never);
    const records = Array.from({ length: 45 }, (_, i) => ({
      ref: `r-${i}`,
      record: { memberName: 'x' },
    }));
    const text = JSON.stringify({ id: 'big', records });
    await receiveWebhook(kit.sctx, pushed.id, await signed(pushed.webhookSecret as string, text));
    const sizes = kit.seams.jobs.map((j) => (j.kind === 'connection.webhook' ? j.refs.length : 0));
    expect(sizes).toEqual([20, 20, 5]);
  });
});

describe('run listing', () => {
  it('orders by start time across id formats', async () => {
    const dto = await createDemo(kit);
    const rows: [string, number][] = [
      ['sync-x-admin-9', 1000],
      ['019aaaaa-uuid', 3000],
      ['sync-x-1', 2000],
    ];
    for (const [id, at] of rows) {
      await run(
        kit.env.DB,
        "INSERT INTO connection_runs (id, connection_id, trigger, started_at, outcome) VALUES (?, ?, 'schedule', ?, 'unchanged')",
        [id, dto.id, at],
      );
    }
    const page1 = await listRuns(kit.env.DB, dto.id, { limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(['019aaaaa-uuid', 'sync-x-1']);
    const next = await listRuns(kit.env.DB, dto.id, { limit: 2, cursor: 'sync-x-1' });
    expect(next.map((r) => r.id)).toEqual(['sync-x-admin-9']);
  });
});

describe('suspended orgs', () => {
  it('stop scheduling, syncing and webhooks', async () => {
    const pushed = await createDemo(kit, {
      connectorType: 'webhook-push',
      config: {},
      mode: 'webhook',
    } as never);
    const dto = await createDemo(kit, { config: { count: 1 } });
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    const due = await listDueConnections(kit.env.DB, kit.clock.now() + 1, 100);
    expect(due.filter((c) => c.orgId === kit.org.id)).toEqual([]);

    const { sctx, created } = withWorkflow(kit);
    await reconcileConnections(sctx);
    expect(created.filter((c) => c.params.connectionId === dto.id)).toEqual([]);

    const text = JSON.stringify({ id: 'e', records: [] });
    await expect(
      receiveWebhook(kit.sctx, pushed.id, await signed(pushed.webhookSecret as string, text)),
    ).rejects.toMatchObject({ status: 404 });

    await processWebhook(kit.sctx, job(dto.id, ['m-001']));
    expect(kit.seams.applied).toEqual([]);
    await executeSync(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule',
      runId: 'r-susp',
      instanceId: 'r-susp',
    });
    expect(kit.seams.applied).toEqual([]);
  });
});

describe('RL_WEBHOOK', () => {
  it('limits per path and ip', async () => {
    const limiter = fakeLimiter(1);
    const env = { ...kit.env, RL_WEBHOOK: limiter as unknown as RateLimit };
    const app = createApp({ stores: fakeAuth().stores, clock: kit.clock });
    const hit = (path: string, ip: string) =>
      app.request(path, { method: 'POST', headers: { 'cf-connecting-ip': ip } }, env);
    expect((await hit('/hooks/connections/a', '1.1.1.1')).status).not.toBe(429);
    const limited = await hit('/hooks/connections/a', '1.1.1.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toContain('application/problem+json');
    expect(((await limited.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect((await hit('/hooks/connections/a', '2.2.2.2')).status).not.toBe(429);
    expect((await hit('/hooks/connections/b', '1.1.1.1')).status).not.toBe(429);
    expect([...limiter.calls.keys()].sort()).toEqual([
      'RL_WEBHOOK:/hooks/connections/a:1.1.1.1',
      'RL_WEBHOOK:/hooks/connections/a:2.2.2.2',
      'RL_WEBHOOK:/hooks/connections/b:1.1.1.1',
    ]);
  });
});

describe('generation fence', () => {
  it('does not auto-create passes once the connection changed mid-step', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    });
    setDeps({
      validateFields: async () => {
        // An admin edits the connection while the step is running.
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          dto.id,
        ]);
      },
    });
    await executeSync(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule',
      runId: 'r-fence',
      instanceId: 'r-fence',
    });
    expect(kit.seams.created).toEqual([]);
  });

  it('counts autoEmail among the fenced settings', async () => {
    const dto = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, { autoEmail: true });
    expect((await getConnection(kit.env.DB, dto.id))?.generation).toBe(2);
  });

  it('invalidates in-flight jobs when disabling, re-enabling, or changing transport', async () => {
    const dto = await createDemo(kit);
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    expect((await getConnection(kit.env.DB, dto.id))?.generation).toBe(2);
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: true });
    expect((await getConnection(kit.env.DB, dto.id))?.generation).toBe(3);
    await service.update(kit.sctx, kit.actor, dto.id, { mode: 'manual' });
    expect((await getConnection(kit.env.DB, dto.id))?.generation).toBe(4);
  });

  it('reports a holder race without marking the pass synced', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    setDeps({
      applyConnectionRecord: async () => {
        throw new ConflictError('owned', 'HOLDER_OWNED');
      },
    });
    await executeSync(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule',
      runId: 'r-holder',
      instanceId: 'r-holder',
    });
    const row = await first<{ sync_error_code: string | null; last_synced_at: number | null }>(
      kit.env.DB,
      'SELECT sync_error_code, last_synced_at FROM passes WHERE id = ?',
      [p.id],
    );
    expect(row?.sync_error_code).toBeNull();
    expect(row?.last_synced_at).toBeNull();
  });

  it('allows only one concurrent configuration edit from the same generation', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
    } as never);
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    setDeps({
      resolver: {
        resolve: async () => {
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
          return ['93.184.216.34'];
        },
      },
    });
    const results = await Promise.allSettled([
      service.update(kit.sctx, kit.actor, dto.id, { config: { baseUrl: 'https://a.example.com' } }),
      service.update(kit.sctx, kit.actor, dto.id, { config: { baseUrl: 'https://b.example.com' } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'CONNECTION_CONFLICT' });
    expect((await getConnection(kit.env.DB, dto.id))?.generation).toBe(2);
  });
});

describe('scheduled pass isolation', () => {
  it('does not update or auto-create over ineligible legacy bindings from listChanges', async () => {
    const dto = await createDemo(kit, {
      config: { count: 6 }, autoCreate: true, defaultTemplateId: kit.templateId,
    });
    const test = await linkedPass(kit, dto.id, 'm-001');
    const voided = await linkedPass(kit, dto.id, 'm-002');
    const deleted = await linkedPass(kit, dto.id, 'm-003');
    const removed = await linkedPass(kit, dto.id, 'm-004');
    const live = await linkedPass(kit, dto.id, 'm-005');
    const quarantined = await linkedPass(kit, dto.id, 'm-006');
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [test.id]);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [deleted.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [removed.id]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [quarantined.id]);
    const ids = [test.id, voided.id, deleted.id, removed.id, quarantined.id];
    const before = await all(kit.env.DB, 'SELECT * FROM passes WHERE id IN (?, ?, ?, ?, ?) ORDER BY id', ids);
    await executeSync(kit.sctx, inlineStep(), {
      connectionId: dto.id, orgId: kit.org.id, generation: 1, trigger: 'schedule',
      runId: 'legacy-run', instanceId: 'legacy-run',
    });
    expect(await all(kit.env.DB, 'SELECT * FROM passes WHERE id IN (?, ?, ?, ?, ?) ORDER BY id', ids)).toEqual(before);
    expect(kit.seams.applied.map((input) => input.passId)).toEqual([live.id]);
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.missing).toEqual([]);
  });

  it('excludes Test, quarantined and foreign passes from Live connection counts', async () => {
    const dto = await createDemo(kit);
    await linkedPass(kit, dto.id, 'live');
    const test = await linkedPass(kit, dto.id, 'test');
    const quarantined = await linkedPass(kit, dto.id, 'quarantined');
    const other = await makeOrg(kit);
    await linkedPass(kit, dto.id, 'foreign', other.id);
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [test.id]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [quarantined.id]);
    expect((await service.getDetail(kit.sctx, dto.id)).metrics.passCount).toBe(1);
    const list = await service.listAll(kit.sctx, { limit: 50 });
    expect(list.items.find((item) => item.id === dto.id)?.passCount).toBe(1);
  });

  it('passes the original Live organization, template version and generation to auto-create', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 }, autoCreate: true, defaultTemplateId: kit.templateId,
    });
    await executeSync(kit.sctx, inlineStep(), {
      connectionId: dto.id, orgId: kit.org.id, generation: 1, trigger: 'schedule',
      runId: 'live-create', instanceId: 'live-create',
    });
    expect(kit.seams.created).toHaveLength(1);
    expect(kit.seams.created[0]).toMatchObject({
      orgId: kit.org.id, mode: 'live', connectionId: dto.id, generation: 1,
      templateId: kit.templateId, templateVersion: expect.any(String), externalRef: 'm-001',
    });
  });

  it('does not fetch a due reference whose pass became Test after selection', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json', config: { baseUrl: 'https://api.example.com' },
      autoCreate: true, defaultTemplateId: kit.templateId,
    } as never);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const context = { connectionId: dto.id, orgId: kit.org.id, generation: 1 };
    expect(await dueRefs(kit.sctx, context)).toEqual(['m-001']);
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]);
    expect(await dueRefs(kit.sctx, context)).toEqual([]);
    const requests: string[] = [];
    setDeps({ fetchImpl: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ memberName: 'Live' }));
    }) as typeof fetch });
    await runRefs(kit.sctx, { ...context, refs: ['m-001'] });
    expect(requests).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  });

  it('rejects a resumed workflow if its organization changed or its snapshot is missing', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    await executeSync(kit.sctx, inlineStep(), {
      connectionId: dto.id, generation: 1, trigger: 'schedule',
      runId: 'old-no-org', instanceId: 'old-no-org',
    } as never);
    const other = await makeOrg(kit);
    await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [other.id, dto.id]);
    await executeSync(kit.sctx, inlineStep(), {
      connectionId: dto.id, orgId: kit.org.id, generation: 1, trigger: 'schedule',
      runId: 'old-org', instanceId: 'old-org',
    });
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(kit.seams.applied).toEqual([]);
    expect(await all(
      kit.env.DB, "SELECT id FROM connection_runs WHERE id IN ('old-no-org', 'old-org')",
    )).toEqual([]);
  });
});
