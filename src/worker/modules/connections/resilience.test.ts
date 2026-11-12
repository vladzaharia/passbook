import { beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg, makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { basicPackage, passJson } from '../templates/package/fixtures.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, sourceOf } from '../templates/testing.ts';
import { getDeps, setDeps } from './deps.ts';
import { dailyConnections, RUN_RETENTION_MS } from './jobs.ts';
import { getConnection } from './repo.ts';
import { listDueConnections } from './repo-list.ts';
import { markPassSyncError, markPassSynced, type SyncSnapshot } from './repo-pass-snapshot.ts';
import { getPassById } from './repo-passes.ts';
import { listRuns } from './repo-runs.ts';
import {
  inlineStep,
  replaceKeysetForTest,
  seedConnectionWorkflow,
  startPendingTransfer,
} from './runtime-fixtures.ts';
import { reconcileConnections } from './schedule.ts';
import * as service from './service.ts';
import { advanceCursor, dueRefs } from './sync.ts';
import { runRefs } from './sync-apply.ts';
import { executeSync } from './sync-runner.ts';
import { createDemo, type Kit, linkedPass, makeKit, withWorkflow } from './test-kit.ts';
import { processWebhook } from './webhook-process.ts';
import { receiveWebhook } from './webhooks.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

async function executeSeeded(...args: Parameters<typeof executeSync>) {
  await seedConnectionWorkflow(args[0], args[2]);
  return executeSync(...args);
}

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

async function hybridWebhook(status: number) {
  setDeps({
    fetchImpl: (async () =>
      new Response(status === 200 ? JSON.stringify({ memberName: 'Live' }) : 'unavailable', {
        status,
      })) as typeof fetch,
  });
  const dto = await createDemo(kit, {
    connectorType: 'http-json',
    config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
    mode: 'hybrid',
  } as never);
  await linkedPass(kit, dto.id, 'm-001');
  await receiveWebhook(
    kit.sctx,
    dto.id,
    await signed(dto.webhookSecret as string, JSON.stringify({ id: 'evt', refs: ['m-001'] })),
  );
  const queued = kit.seams.jobs[0];
  if (queued?.kind !== 'connection.webhook') throw new Error('no job');
  return { dto, queued };
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
    await executeSeeded(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
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
    const step = inlineStep();
    const failing = {
      ...step,
      do: async (name: string, fn: () => Promise<unknown>) => {
        if (name === 'limits') throw new Error('step exhausted');
        return step.do(name, fn as never);
      },
    };
    await expect(
      executeSeeded(kit.sctx, failing as never, {
        connectionId: dto.id,
        orgId: kit.org.id,
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
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
    await executeSeeded(kit.sctx, step, {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
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
    const { dto, queued } = await hybridWebhook(200);
    await run(kit.env.DB, 'UPDATE connections SET next_run_at = ? WHERE id = ?', [
      kit.clock.now() + 1000,
      dto.id,
    ]);
    await processWebhook(kit.sctx, queued);
    const conn = await getConnection(kit.env.DB, dto.id);
    expect(conn?.nextRunAt).toBe(kit.clock.now() + 1000);
    expect(conn?.lastSuccessAt).toBe(kit.clock.now());
  });

  it('throw on transient upstream failures so the queue retries', async () => {
    const { dto, queued } = await hybridWebhook(503);
    await expect(processWebhook(kit.sctx, queued)).rejects.toMatchObject({
      code: 'WEBHOOK_UPSTREAM',
    });
    expect((await getConnection(kit.env.DB, dto.id))?.consecutiveFailures).toBe(1);
  });

  it('do not retry permanent auth failures', async () => {
    const { dto, queued } = await hybridWebhook(401);
    await processWebhook(kit.sctx, queued);
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
    const pass = await linkedPass(kit, pushed.id, 'm-001');
    const incoming = JSON.stringify({
      id: 'before-suspension',
      records: [{ ref: 'm-001', record: { memberName: 'Changed' } }],
    });
    await receiveWebhook(
      kit.sctx,
      pushed.id,
      await signed(pushed.webhookSecret as string, incoming),
    );
    const queued = kit.seams.jobs[0];
    if (queued?.kind !== 'connection.webhook') throw new Error('Missing retained webhook job');
    const beforePass = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const sync = {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      trigger: 'schedule' as const,
      runId: 'r-susp',
      instanceId: 'r-susp',
    };
    await seedConnectionWorkflow(kit.sctx, sync);
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

    await processWebhook(kit.sctx, queued);
    expect(
      await first(
        kit.env.DB,
        `SELECT state, error_code FROM connection_webhook_retention
      WHERE connection_id = ? AND event_id = ?`,
        [pushed.id, 'before-suspension'],
      ),
    ).toEqual({ state: 'ignored', error_code: 'WEBHOOK_STALE_CONTEXT' });
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
      beforePass,
    );
    expect(kit.seams.applied).toEqual([]);
    await executeSync(kit.sctx, inlineStep(), sync);
    expect(kit.seams.applied).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        "SELECT outcome, error_code FROM connection_runs WHERE id = 'r-susp'",
      ),
    ).toEqual({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
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
      config: { count: 1 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    });
    const createPass = getDeps().createPassFromConnection;
    setDeps({
      createPassFromConnection: async (ctx, input) => {
        // The edit lands after the connection-side fence but before the fake service commits.
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          dto.id,
        ]);
        return createPass(ctx, input);
      },
    });
    await executeSeeded(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      trigger: 'schedule',
      runId: 'r-fence',
      instanceId: 'r-fence',
    });
    expect(kit.seams.createAttempts).toHaveLength(1);
    expect(kit.seams.created).toEqual([]);
    expect(
      await all(kit.env.DB, 'SELECT id FROM passes WHERE connection_id = ?', [dto.id]),
    ).toEqual([]);
    expect(await getConnection(kit.env.DB, dto.id)).toMatchObject({ generation: 2, cursor: null });
    expect(
      await first(kit.env.DB, 'SELECT outcome, error_code FROM connection_runs WHERE id = ?', [
        'r-fence',
      ]),
    ).toEqual({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
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
    await executeSeeded(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
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
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      code: 'CONNECTION_CONFLICT',
    });
    expect((await getConnection(kit.env.DB, dto.id))?.generation).toBe(2);
  });
});

describe('sync bookkeeping snapshot fence', () => {
  it.each([
    ['Test mode', null],
    ['voided status', "UPDATE passes SET status = 'voided' WHERE id = ?"],
  ])('rejects even a forged matching %s snapshot', async (_label, sql) => {
    const connection = await createDemo(kit);
    const pass = await linkedPass(
      kit,
      connection.id,
      'm-001',
      kit.org.id,
      _label === 'Test mode' ? 'test' : 'live',
    );
    if (sql) await run(kit.env.DB, sql, [pass.id]);
    const stored = await getPassById(kit.env.DB, pass.id);
    if (!stored) throw new Error('Missing bound pass');
    const snapshot = {
      passId: stored.id,
      orgId: stored.orgId,
      identityId: stored.identityId,
      // Deliberately bypass the TypeScript contract to exercise the D1 predicate.
      mode: stored.mode as 'live',
      status: stored.status as 'active',
      expectedVersion: stored.version,
      expectedRowVersion: stored.rowVersion,
      ownerUserId: stored.ownerUserId,
      linkGeneration: stored.linkGeneration,
      credentialGeneration: stored.credentialGeneration,
      lifecycleGeneration: stored.lifecycleGeneration,
      credentialKeysetCommitment: stored.credentialKeysetCommitment,
      transferPending: stored.transferPending,
      connectionId: connection.id,
      externalRef: 'm-001',
      generation: 1,
      expectedConnectionMode: 'poll' as const,
    };
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    expect(
      await markPassSynced(kit.sctx, { ...snapshot, now: kit.clock.now(), nextSyncAt: null }),
    ).toBe(false);
    expect(
      await markPassSyncError(kit.sctx, { ...snapshot, code: 'INVALID_INPUT', nextSyncAt: null }),
    ).toBe(false);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
  });

  it.each([
    'identity mismatch',
    'credential mismatch',
    'lifecycle transition',
    'pending transfer',
  ] as const)('fences success and error bookkeeping for %s', async (change) => {
    const connection = await createDemo(kit);
    const pass = await linkedPass(kit, connection.id, 'm-001');
    const stored = await getPassById(kit.env.DB, pass.id);
    if (!stored) throw new Error('Missing bound pass');
    const snapshot: SyncSnapshot = {
      passId: stored.id,
      orgId: stored.orgId,
      identityId: stored.identityId,
      mode: 'live',
      status: 'active',
      expectedVersion: stored.version,
      expectedRowVersion: stored.rowVersion,
      ownerUserId: stored.ownerUserId,
      linkGeneration: stored.linkGeneration,
      credentialGeneration: stored.credentialGeneration,
      lifecycleGeneration: stored.lifecycleGeneration,
      credentialKeysetCommitment: stored.credentialKeysetCommitment,
      transferPending: stored.transferPending,
      connectionId: connection.id,
      externalRef: 'm-001',
      generation: 1,
      expectedConnectionMode: 'poll',
    };
    if (change === 'pending transfer') await startPendingTransfer(kit.sctx, pass.id);
    if (change === 'lifecycle transition') {
      await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
      await run(kit.env.DB, "UPDATE passes SET status = 'active' WHERE id = ?", [pass.id]);
    }
    const current = await getPassById(kit.env.DB, pass.id);
    if (!current) throw new Error('Missing changed pass');
    if (change === 'lifecycle transition') {
      expect(current.status).toBe('active');
      expect(current.lifecycleGeneration).toBe(snapshot.lifecycleGeneration + 2);
    }
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    const attempted =
      change === 'identity mismatch'
        ? { ...snapshot, identityId: `${snapshot.identityId}-other` }
        : change === 'credential mismatch'
          ? { ...snapshot, credentialGeneration: snapshot.credentialGeneration + 1 }
          : snapshot;
    const attempts = [attempted];
    if (change === 'pending transfer') {
      expect(current.transferPending).toBe(true);
      // Even a forged snapshot with the current epochs cannot bypass the pending-transfer guard.
      attempts.push({
        ...snapshot,
        credentialGeneration: current.credentialGeneration,
        lifecycleGeneration: current.lifecycleGeneration,
        linkGeneration: current.linkGeneration,
        transferPending: false,
      });
    }
    for (const candidate of attempts) {
      expect(
        await markPassSynced(kit.sctx, { ...candidate, now: kit.clock.now(), nextSyncAt: null }),
      ).toBe(false);
      expect(
        await markPassSyncError(kit.sctx, {
          ...candidate,
          code: 'INVALID_INPUT',
          nextSyncAt: 100,
        }),
      ).toBe(false);
    }
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(outbox);
  });

  it('fences success and error bookkeeping when the keyset changes after capture', async () => {
    const connection = await createDemo(kit);
    const pass = await linkedPass(kit, connection.id, 'm-001');
    const stored = await getPassById(kit.env.DB, pass.id);
    if (!stored) throw new Error('Missing bound pass');
    const snapshot: SyncSnapshot = {
      passId: stored.id,
      orgId: stored.orgId,
      identityId: stored.identityId,
      mode: 'live',
      status: 'active',
      expectedVersion: stored.version,
      expectedRowVersion: stored.rowVersion,
      ownerUserId: stored.ownerUserId,
      linkGeneration: stored.linkGeneration,
      credentialGeneration: stored.credentialGeneration,
      lifecycleGeneration: stored.lifecycleGeneration,
      credentialKeysetCommitment: stored.credentialKeysetCommitment,
      transferPending: stored.transferPending,
      connectionId: connection.id,
      externalRef: 'm-001',
      generation: 1,
      expectedConnectionMode: 'poll',
    };
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    const other =
      kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    try {
      await replaceKeysetForTest(kit.sctx, other);
      expect(
        await markPassSynced(kit.sctx, { ...snapshot, now: kit.clock.now(), nextSyncAt: null }),
      ).toBe(false);
      expect(
        await markPassSyncError(kit.sctx, {
          ...snapshot,
          code: 'INVALID_INPUT',
          nextSyncAt: 100,
        }),
      ).toBe(false);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        before,
      );
      expect(
        await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
      ).toEqual(outbox);
    } finally {
      await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
    }
  });

  it.each([
    { credentialGeneration: undefined },
    { credentialGeneration: 0 },
    { credentialGeneration: 1.5 },
    { lifecycleGeneration: undefined },
    { lifecycleGeneration: -1 },
    { lifecycleGeneration: 0.5 },
    { credentialKeysetCommitment: undefined },
    { credentialKeysetCommitment: 'invalid' },
    { transferPending: undefined },
    { transferPending: true },
    { identityId: undefined },
    { expectedConnectionMode: undefined },
    { expectedConnectionMode: 'invalid' },
    { expectedConnectionMode: 'webhook' },
  ])('fails closed for a malformed bookkeeping snapshot %#', async (invalid) => {
    const connection = await createDemo(kit);
    const pass = await linkedPass(kit, connection.id, 'm-001');
    const stored = await getPassById(kit.env.DB, pass.id);
    if (!stored) throw new Error('Missing bound pass');
    const attempted = {
      passId: stored.id,
      orgId: stored.orgId,
      identityId: stored.identityId,
      mode: 'live',
      status: 'active',
      expectedVersion: stored.version,
      expectedRowVersion: stored.rowVersion,
      ownerUserId: stored.ownerUserId,
      linkGeneration: stored.linkGeneration,
      credentialGeneration: stored.credentialGeneration,
      lifecycleGeneration: stored.lifecycleGeneration,
      transferPending: stored.transferPending,
      credentialKeysetCommitment: stored.credentialKeysetCommitment,
      connectionId: connection.id,
      externalRef: 'm-001',
      generation: 1,
      expectedConnectionMode: 'poll',
      ...invalid,
    } as SyncSnapshot;
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    expect(
      await markPassSynced(kit.sctx, { ...attempted, now: kit.clock.now(), nextSyncAt: null }),
    ).toBe(false);
    expect(
      await markPassSyncError(kit.sctx, {
        ...attempted,
        code: 'INVALID_INPUT',
        nextSyncAt: null,
      }),
    ).toBe(false);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
  });

  it('accepts active Live snapshots and still rejects stale generations', async () => {
    const connection = await createDemo(kit);
    const pass = await linkedPass(kit, connection.id, 'm-001');
    const stored = await getPassById(kit.env.DB, pass.id);
    if (!stored) throw new Error('Missing bound pass');
    const snapshot = {
      passId: stored.id,
      orgId: stored.orgId,
      identityId: stored.identityId,
      mode: 'live' as const,
      status: 'active' as const,
      expectedVersion: stored.version,
      expectedRowVersion: stored.rowVersion,
      ownerUserId: stored.ownerUserId,
      linkGeneration: stored.linkGeneration,
      credentialGeneration: stored.credentialGeneration,
      lifecycleGeneration: stored.lifecycleGeneration,
      credentialKeysetCommitment: stored.credentialKeysetCommitment,
      transferPending: stored.transferPending,
      connectionId: connection.id,
      externalRef: 'm-001',
      generation: 1,
      expectedConnectionMode: 'poll' as const,
    };
    expect(
      await markPassSyncError(kit.sctx, { ...snapshot, code: 'INVALID_INPUT', nextSyncAt: 100 }),
    ).toBe(true);
    expect(
      await markPassSynced(kit.sctx, { ...snapshot, now: kit.clock.now(), nextSyncAt: 200 }),
    ).toBe(true);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    expect(before).toMatchObject({
      sync_error_code: null,
      sync_failures: 0,
      last_synced_at: kit.clock.now(),
      next_sync_at: 200,
    });
    await service.update(kit.sctx, kit.actor, connection.id, { config: { count: 4 } });
    expect(
      await markPassSynced(kit.sctx, { ...snapshot, now: kit.clock.now(), nextSyncAt: null }),
    ).toBe(false);
    expect(
      await markPassSyncError(kit.sctx, { ...snapshot, code: 'STALE', nextSyncAt: null }),
    ).toBe(false);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
  });

  it('accepts an effective global baked release; supersession fences publishing, not bookkeeping', async () => {
    const slug = `retained-global-${kit.org.id.slice(-8)}`;
    const manifest = JSON.stringify(makeTemplate().resolved.manifest);
    const [initial, replacement] = await Promise.all([
      bakedFrom(
        slug,
        basicPackage({ 'wallet.template.json': manifest }, passJson({ description: 'Original' })),
      ),
      bakedFrom(
        slug,
        basicPackage(
          { 'wallet.template.json': manifest },
          passJson({ description: 'Replacement' }),
        ),
      ),
    ]);
    const assets = fakeAssets();
    for (const fixture of [initial, replacement]) {
      for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
    }
    // A later Worker upload is what supersedes a global head; builds without an order only serve it.
    const workerAt = (id: string, timestamp: string) => ({
      ...kit.sctx,
      env: { ...kit.env, ASSETS: assets, CF_VERSION: { id, tag: '', timestamp } },
    });
    const sctx = workerAt('retained-global-old', '2026-01-01T00:00:00Z');
    const next = workerAt('retained-global-new', '2026-02-01T00:00:00Z');
    resetBakedSync();
    try {
      await syncBakedTemplates(sctx, sourceOf([initial], `${slug}-initial`));
      const release = await requireApprovedRelease(
        sctx,
        initial.template.id,
        kit.org.id,
        'live',
        'apple',
      );
      expect(release).toMatchObject({ orgId: null, version: initial.template.version });
      const connection = await createDemo(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com' },
        mode: 'hybrid',
        autoCreate: true,
        defaultTemplateId: initial.template.id,
      });
      const template = makeTemplate({
        id: initial.template.id,
        version: initial.template.version,
      }).resolved;
      // The baked sync already stored this version; persisting the fixture again would compare it.
      const pass = await makePass(kit, { orgId: kit.org.id, template, persist: false });
      await run(
        kit.env.DB,
        'UPDATE passes SET connection_id = ?, external_ref = ?, release_id = ? WHERE id = ?',
        [connection.id, 'global-ref', release.id, pass.id],
      );
      const stored = await getPassById(kit.env.DB, pass.id);
      if (!stored) throw new Error('Missing bound pass');
      const snapshot = {
        passId: stored.id,
        orgId: kit.org.id,
        identityId: stored.identityId,
        mode: 'live' as const,
        status: 'active' as const,
        expectedVersion: stored.version,
        expectedRowVersion: stored.rowVersion,
        ownerUserId: stored.ownerUserId,
        linkGeneration: stored.linkGeneration,
        credentialGeneration: stored.credentialGeneration,
        lifecycleGeneration: stored.lifecycleGeneration,
        credentialKeysetCommitment: stored.credentialKeysetCommitment,
        transferPending: stored.transferPending,
        connectionId: connection.id,
        externalRef: 'global-ref',
        generation: 1,
        expectedConnectionMode: 'hybrid' as const,
        retainedBinding: {
          templateId: stored.templateId,
          templateVersion: stored.templateVersion,
          releaseId: stored.releaseId,
          credentialKeysetCommitment: stored.credentialKeysetCommitment,
        },
        retainedTemplateId: initial.template.id,
        retainedReleaseProof: {
          id: release.id,
          generation: release.generation,
          version: release.version,
        },
      };
      expect(
        await markPassSyncError(kit.sctx, {
          ...snapshot,
          code: 'INVALID_INPUT',
          nextSyncAt: 100,
        }),
      ).toBe(true);
      expect(
        await markPassSynced(kit.sctx, { ...snapshot, now: kit.clock.now(), nextSyncAt: 200 }),
      ).toBe(true);
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);

      resetBakedSync();
      await syncBakedTemplates(next, sourceOf([replacement], `${slug}-replacement`));
      const current = await requireApprovedRelease(
        next,
        initial.template.id,
        kit.org.id,
        'live',
        'apple',
      );
      expect(current.orgId).toBeNull();
      expect(current.id).not.toBe(release.id);
      // Sync bookkeeping is volatile and bound to the pass's own captured release, so a newer global head
      // does not stop it; a publish under the old proof is refused (retained-release-fence.test.ts,
      // 'rejects a superseded release').
      expect(
        await markPassSyncError(kit.sctx, { ...snapshot, code: 'LATER', nextSyncAt: 300 }),
      ).toBe(true);
      expect(
        await first(kit.env.DB, 'SELECT sync_error_code, next_sync_at FROM passes WHERE id = ?', [
          pass.id,
        ]),
      ).toEqual({ sync_error_code: 'LATER', next_sync_at: 300 });
      expect(
        await first(kit.env.DB, 'SELECT release_id FROM passes WHERE id = ?', [pass.id]),
      ).toEqual({ release_id: (before as { release_id: string }).release_id });
    } finally {
      resetBakedSync();
    }
  }, 60_000);
});

describe('scheduled pass isolation', () => {
  it('does not update or auto-create over ineligible legacy bindings from listChanges', async () => {
    const dto = await createDemo(kit, {
      config: { count: 6 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    });
    const test = await linkedPass(kit, dto.id, 'm-001', kit.org.id, 'test');
    const voided = await linkedPass(kit, dto.id, 'm-002');
    const deleted = await linkedPass(kit, dto.id, 'm-003');
    const removed = await linkedPass(kit, dto.id, 'm-004');
    const live = await linkedPass(kit, dto.id, 'm-005');
    const quarantined = await linkedPass(kit, dto.id, 'm-006');
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [deleted.id]);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [removed.id]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      quarantined.id,
    ]);
    const ids = [test.id, voided.id, deleted.id, removed.id, quarantined.id];
    const before = await all(
      kit.env.DB,
      'SELECT * FROM passes WHERE id IN (?, ?, ?, ?, ?) ORDER BY id',
      ids,
    );
    await executeSeeded(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule',
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      runId: 'legacy-run',
      instanceId: 'legacy-run',
    });
    expect(
      await all(kit.env.DB, 'SELECT * FROM passes WHERE id IN (?, ?, ?, ?, ?) ORDER BY id', ids),
    ).toEqual(before);
    expect(kit.seams.applied.map((input) => input.passId)).toEqual([live.id]);
    expect(kit.seams.created).toEqual([]);
    expect(kit.seams.missing).toEqual([]);
  });

  it('excludes Test, quarantined and foreign passes from Live connection counts', async () => {
    const dto = await createDemo(kit);
    await linkedPass(kit, dto.id, 'live');
    await linkedPass(kit, dto.id, 'test', kit.org.id, 'test');
    const quarantined = await linkedPass(kit, dto.id, 'quarantined');
    const other = await makeOrg(kit);
    await linkedPass(kit, dto.id, 'foreign', other.id);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      quarantined.id,
    ]);
    expect((await service.getDetail(kit.sctx, dto.id)).metrics.passCount).toBe(1);
    const list = await service.listAll(kit.sctx, { limit: 50 });
    expect(list.items.find((item) => item.id === dto.id)?.passCount).toBe(1);
  });

  it('passes the original Live organization, template id and generation to auto-create', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/memberName' } },
    });
    await executeSeeded(kit.sctx, inlineStep(), {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule',
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      runId: 'live-create',
      instanceId: 'live-create',
    });
    expect(kit.seams.created).toHaveLength(1);
    expect(kit.seams.created[0]).toEqual({
      orgId: kit.org.id,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      mode: 'live',
      connectionId: dto.id,
      generation: 1,
      expectedConnectionMode: 'poll',
      templateId: kit.templateId,
      expectedRelease: { ...kit.seams.release },
      externalRef: 'm-001',
      fields: { memberName: 'Member M-001' },
      holderEmail: null,
      sendEmail: false,
    });
  });

  it('does not fetch voided or Test-bound references after due selection', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    } as never);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const testPass = await linkedPass(kit, dto.id, 'm-test', kit.org.id, 'test');
    const beforeTest = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [testPass.id]);
    const context = {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      mode: 'poll' as const,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
    };
    expect(await dueRefs(kit.sctx, context)).toEqual({ refs: ['m-001'] });
    const missingProof = { ...context, credentialKeysetCommitment: undefined };
    const changedProof = {
      ...context,
      credentialKeysetCommitment:
        kit.credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
    };
    expect(await dueRefs(kit.sctx, missingProof as never)).toEqual({
      refs: null,
      staleCode: 'STALE_CONTEXT',
    });
    expect(await dueRefs(kit.sctx, changedProof)).toEqual({
      refs: null,
      staleCode: 'STALE_CONTEXT',
    });
    for (const invalid of [missingProof, changedProof]) {
      expect(
        await runRefs(kit.sctx, {
          ...invalid,
          refs: ['m-001'],
          release: { kind: 'approved', ...kit.seams.release },
        } as never),
      ).toMatchObject({ stale: true });
    }
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    expect(await dueRefs(kit.sctx, context)).toEqual({ refs: [] });
    const requests: string[] = [];
    setDeps({
      fetchImpl: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ memberName: 'Live' }));
      }) as typeof fetch,
    });
    await runRefs(kit.sctx, {
      ...context,
      refs: ['m-001', 'm-test'],
      release: { kind: 'approved', ...kit.seams.release },
    });
    expect(requests).toEqual([]);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [testPass.id])).toEqual(
      beforeTest,
    );
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  });

  it('distinguishes stale generations from invalid keysets before fan-out', async () => {
    const dto = await createDemo(kit);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const context = {
      connectionId: dto.id,
      orgId: kit.org.id,
      mode: 'poll' as const,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
    };
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const other =
      kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    expect(await dueRefs(kit.sctx, { ...context, credentialKeysetCommitment: other })).toEqual({
      refs: null,
      staleCode: 'STALE_CONTEXT',
    });
    expect(
      await advanceCursor(kit.sctx, {
        ...context,
        credentialKeysetCommitment: other,
        cursor: 'must-not-advance',
      }),
    ).toEqual({ stale: true, staleCode: 'STALE_CONTEXT' });
    await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
      dto.id,
    ]);
    expect(await dueRefs(kit.sctx, context)).toEqual({ refs: null, staleCode: 'STALE_GENERATION' });
    expect(await advanceCursor(kit.sctx, { ...context, cursor: 'must-not-advance' })).toEqual({
      stale: true,
      staleCode: 'STALE_GENERATION',
    });
    expect(
      await runRefs(kit.sctx, {
        ...context,
        refs: ['m-001'],
        release: { kind: 'approved', ...kit.seams.release },
      }),
    ).toMatchObject({ stale: true, staleCode: 'STALE_GENERATION' });
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBeNull();
  });

  it('rejects a resumed workflow if its organization changed or its snapshot is missing', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const sync = {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule' as const,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      runId: 'old-org',
      instanceId: 'old-org',
    };
    await seedConnectionWorkflow(kit.sctx, sync);
    await expect(
      executeSync(kit.sctx, inlineStep(), { ...sync, orgId: undefined } as never),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    const other = await makeOrg(kit);
    await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [other.id, dto.id]);
    await executeSync(kit.sctx, inlineStep(), sync);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(kit.seams.applied).toEqual([]);
    expect(
      await first(
        kit.env.DB,
        "SELECT outcome, error_code FROM connection_runs WHERE id = 'old-org'",
      ),
      // Closing runs on a platform grant pinned to the job's org: it cannot close a run of a
      // connection that another org now holds (close-org-pin.test.ts).
    ).toEqual({ outcome: 'running', error_code: null });
  });

  it('fails closed when an old workflow lacks its original proof or tracking pair', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const sync = {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule' as const,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      runId: 'proof-run',
      instanceId: 'proof-run',
    };
    await seedConnectionWorkflow(kit.sctx, sync);
    const beforePass = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const beforeRun = await first(kit.env.DB, 'SELECT * FROM connection_runs WHERE id = ?', [
      sync.runId,
    ]);
    const beforeWorkflow = await first(
      kit.env.DB,
      'SELECT * FROM workflow_runs WHERE instance_id = ?',
      [sync.instanceId],
    );
    const different =
      kit.credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const old = [
      { ...sync, credentialKeysetCommitment: undefined },
      { ...sync, credentialKeysetCommitment: different },
      { ...sync, runId: 'untracked', instanceId: 'untracked' },
    ];
    for (const params of old) {
      await expect(executeSync(kit.sctx, inlineStep(), params as never)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
    }
    try {
      await replaceKeysetForTest(kit.sctx, different);
      await expect(executeSync(kit.sctx, inlineStep(), sync)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
    } finally {
      await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
    }
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
      beforePass,
    );
    expect(
      await first(kit.env.DB, 'SELECT * FROM connection_runs WHERE id = ?', [sync.runId]),
    ).toEqual(beforeRun);
    expect(
      await first(kit.env.DB, 'SELECT * FROM workflow_runs WHERE instance_id = ?', [
        sync.instanceId,
      ]),
    ).toEqual(beforeWorkflow);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  });
});
