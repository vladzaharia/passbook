import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { handleQueue } from '../../jobs/queue.ts';
import { JOBS_QUEUE } from '../../jobs/retry.ts';
import { type JobOf, JobSchema } from '../../jobs/types.ts';
import { claim } from '../../platform/counters.ts';
import { all, first, run } from '../../platform/db.ts';
import { createLogger } from '../../platform/log.ts';
import { insertPushOutbox } from '../delivery/repo-outbox-enqueue.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { getDeps, setDeps } from './deps.ts';
import {
  dailyConnections,
  handlePassRefresh,
  RUN_RETENTION_MS,
  reconcileConnections,
  WEBHOOK_RETENTION_MS,
} from './jobs.ts';
import { sealLegacyWebhookInbox } from './legacy-inbox.ts';
import { quarantineLegacyWebhookEvents } from './legacy-quarantine.ts';
import { getConnection } from './repo.ts';
import { getPassById } from './repo-passes.ts';
import { deleteOldWebhookEvents } from './repo-sync.ts';
import { inlineStep, replaceKeysetForTest, startPendingTransfer } from './runtime-fixtures.ts';
import { reconcileConnections as schedule, scheduledInstanceId } from './schedule.ts';
import * as service from './service.ts';
import { executeSync, type SyncRunParams } from './sync-runner.ts';
import {
  createDemo,
  type Kit,
  linkedPass,
  makeKit,
  testModePass,
  withWorkflow,
} from './test-kit.ts';
import { retainLegacyQueuedWebhook } from './webhook-retention.ts';
import { receiveWebhook } from './webhooks.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

async function snapshot(
  passId: string,
  trigger: 'user' | 'admin' = 'user',
): Promise<JobOf<'pass.refresh'>> {
  const pass = await getPassById(kit.env.DB, passId);
  if (!pass) throw new Error(`Missing pass ${passId}`);
  const conn = pass.connectionId ? await getConnection(kit.env.DB, pass.connectionId) : null;
  if (pass.connectionId && !conn) throw new Error(`Missing connection ${pass.connectionId}`);
  return {
    kind: 'pass.refresh',
    passId,
    orgId: pass.orgId,
    identityId: pass.identityId,
    mode: pass.mode,
    status: pass.status,
    passVersion: pass.version,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    releaseId: pass.releaseId,
    ownerUserId: pass.ownerUserId,
    linkGeneration: pass.linkGeneration,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    credentialKeysetCommitment: pass.credentialKeysetCommitment,
    connectionId: pass.connectionId,
    externalRef: pass.externalRef,
    generation: conn?.generation ?? null,
    connectionMode: conn?.mode ?? null,
    trigger,
    actorId: 'u1',
  };
}

async function refresh(passId: string, trigger: 'user' | 'admin' = 'user') {
  await handlePassRefresh(await snapshot(passId, trigger), kit.sctx);
}

const passTimes = (id: string) =>
  first<{ last_refreshed_at: number | null }>(
    kit.env.DB,
    'SELECT last_refreshed_at FROM passes WHERE id = ?',
    [id],
  );

describe('pass.refresh', () => {
  it('fetches an unchanged record, re-pushes it, and stamps last_refreshed_at', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    kit.seams.changed = false;
    kit.clock.advance(5);
    await refresh(p.id);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.applied[0]).toMatchObject({
      passId: p.id,
      expectedConnectionMode: 'poll',
      cause: 'user_refresh',
      fields: { memberId: 'm-001' },
    });
    expect(kit.seams.pushes).toEqual([{ passId: p.id, reason: 'refresh' }]);
    expect((await passTimes(p.id))?.last_refreshed_at).toBe(kit.clock.now());
    const runs = await all<{ trigger: string; outcome: string; pass_id: string; actor_id: string }>(
      kit.env.DB,
      'SELECT trigger, outcome, pass_id, actor_id FROM connection_runs WHERE connection_id = ?',
      [dto.id],
    );
    expect(runs).toEqual([
      { trigger: 'user', outcome: 'unchanged', pass_id: p.id, actor_id: 'u1' },
    ]);
  });

  it('passes the unchanged admitted refresh snapshot to the catch-up enqueue', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    kit.seams.changed = false;
    const job = await snapshot(pass.id);
    expect(job.connectionMode).toBe('poll');
    const enqueue = getDeps().enqueueRefreshPush;
    let admitted: unknown;
    setDeps({
      enqueueRefreshPush: async (ctx, input) => {
        admitted = input;
        return enqueue(ctx, input);
      },
    });
    await handlePassRefresh(job, kit.sctx);
    expect(admitted).toEqual(job);
    expect(kit.seams.pushes).toEqual([{ passId: pass.id, reason: 'refresh' }]);
  });

  it('preserves a real issuing release in the refresh snapshot and rejects a changed binding', async () => {
    const template = makeTemplate({ id: kit.templateId, orgId: kit.org.id });
    const release = await approveAppleRelease(
      { ctx: kit.sctx, fx: kit, registry: template.registry },
      {
        orgId: kit.org.id,
        mode: 'live',
        templateId: kit.templateId,
        version: template.resolved.version,
      },
    );
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    await run(kit.env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [release.id, pass.id]);
    kit.seams.changed = false;
    const job = await snapshot(pass.id);
    expect(job.releaseId).toBe(release.id);
    await handlePassRefresh(job, kit.sctx);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.applied[0]).toMatchObject({
      identityId: job.identityId,
      credentialGeneration: job.credentialGeneration,
      lifecycleGeneration: job.lifecycleGeneration,
      credentialKeysetCommitment: job.credentialKeysetCommitment,
      expectedConnectionMode: job.connectionMode,
      retainedBinding: {
        templateId: job.templateId,
        templateVersion: job.templateVersion,
        releaseId: release.id,
        credentialKeysetCommitment: job.credentialKeysetCommitment,
      },
    });
    expect(kit.seams.pushes).toEqual([{ passId: pass.id, reason: 'refresh' }]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [pass.id]);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    await handlePassRefresh(job, kit.sctx);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.pushes).toHaveLength(1);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(outbox);
  }, 60_000);

  it('enqueues one guarded refresh using the exact post-CAS metadata when no push was published', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    kit.seams.changed = false;
    const job = await snapshot(pass.id);
    const apply = getDeps().applyConnectionRecord;
    const enqueue = getDeps().enqueueRefreshPush;
    let admitted: unknown;
    setDeps({
      applyConnectionRecord: async (...args) => {
        await run(
          kit.env.DB,
          `UPDATE passes SET version = version + 1,
          link_generation = link_generation + 1 WHERE id = ?`,
          [pass.id],
        );
        const result = await apply(...args);
        return {
          ...result,
          version: result.version + 1,
          linkGeneration: result.linkGeneration + 1,
        };
      },
      enqueueRefreshPush: async (ctx, input) => {
        admitted = input;
        return enqueue(ctx, input);
      },
    });
    await handlePassRefresh(job, kit.sctx);
    expect(admitted).toEqual({
      ...job,
      passVersion: job.passVersion + 1,
      linkGeneration: job.linkGeneration + 1,
    });
    expect(kit.seams.pushes).toEqual([{ passId: pass.id, reason: 'refresh' }]);
    expect((await passTimes(pass.id))?.last_refreshed_at).toBe(kit.clock.now());
  });

  it('stamps without enqueueing a second push when publication already queued one', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const job = await snapshot(pass.id);
    const apply = getDeps().applyConnectionRecord;
    const outboxId = `published-${pass.id}`;
    setDeps({
      applyConnectionRecord: async (...args) => {
        const result = await apply(...args);
        expect(
          await insertPushOutbox(kit.sctx, {
            id: outboxId,
            orgId: job.orgId,
            mode: 'live',
            passId: job.passId,
            identityId: job.identityId,
            credentialGeneration: job.credentialGeneration,
            lifecycleGeneration: job.lifecycleGeneration,
            templateId: job.templateId,
            templateVersion: job.templateVersion,
            releaseId: job.releaseId,
            coalesceKey: null,
            payload: { reason: 'connection' },
            now: kit.clock.now(),
          }),
        ).toBe('inserted');
        return result;
      },
    });
    await handlePassRefresh(job, kit.sctx);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.pushes).toEqual([]);
    expect(await all(kit.env.DB, 'SELECT id FROM outbox WHERE pass_id = ?', [pass.id])).toEqual([
      { id: outboxId },
    ]);
    expect((await passTimes(pass.id))?.last_refreshed_at).toBe(kit.clock.now());
  });

  it.each([
    'version',
    'link',
    'lifecycle',
    'connection',
    'connection mode',
    'reference',
    'unbound',
    'status',
    'pending transfer',
  ] as const)(
    'does not stamp a published refresh when %s changes after bookkeeping',
    async (race) => {
      const dto = await createDemo(kit, { config: { count: 1 } });
      const pass = await linkedPass(kit, dto.id, 'm-001');
      const job = await snapshot(pass.id);
      const trigger = `refresh_race_${kit.ids.id().replaceAll('-', '')}`;
      const body = {
        version: 'UPDATE passes SET version = version + 1 WHERE id = NEW.id;',
        link: 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = NEW.id;',
        lifecycle:
          'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = NEW.id;',
        connection:
          'UPDATE connections SET generation = generation + 1 WHERE id = NEW.connection_id;',
        'connection mode': "UPDATE connections SET mode = 'manual' WHERE id = NEW.connection_id;",
        reference: "UPDATE passes SET external_ref = 'other-ref' WHERE id = NEW.id;",
        unbound: 'UPDATE passes SET connection_id = NULL, external_ref = NULL WHERE id = NEW.id;',
        status: "UPDATE passes SET status = 'voided' WHERE id = NEW.id;",
        'pending transfer': `INSERT INTO pass_credential_transfers
          (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision,
           source_row_version, source_lifecycle_generation, source_link_generation, target_holder_email,
           target_owner_user_id, requested_by_type, requested_by_id, requested_at, completed_at)
          SELECT '${kit.ids.id()}', id, org_id, mode, 'pending', credential_generation, version, revision,
            row_version, lifecycle_generation, link_generation + 1, 'next@example.test', NULL, 'system', NULL,
            ${kit.clock.now()}, NULL FROM passes WHERE id = NEW.id;
          UPDATE passes SET credential_generation = credential_generation + 1,
            download_token = '${kit.ids.token()}', link_generation = link_generation + 1 WHERE id = NEW.id;`,
      }[race];
      await run(
        kit.env.DB,
        `CREATE TRIGGER ${trigger} AFTER UPDATE OF last_synced_at ON passes
        BEGIN ${body} END`,
      );
      try {
        const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
          pass.id,
        ]);
        await handlePassRefresh(job, kit.sctx);
        expect(kit.seams.applied).toHaveLength(1);
        expect(kit.seams.pushes).toEqual([]);
        expect(
          await first<{ last_synced_at: number | null; last_refreshed_at: number | null }>(
            kit.env.DB,
            'SELECT last_synced_at, last_refreshed_at FROM passes WHERE id = ?',
            [pass.id],
          ),
        ).toEqual({ last_synced_at: kit.clock.now(), last_refreshed_at: null });
        expect(
          await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
        ).toEqual(outbox);
      } finally {
        await run(kit.env.DB, `DROP TRIGGER ${trigger}`);
      }
    },
  );

  it('uses the connection cause for admin refreshes', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    await refresh(p.id, 'admin');
    expect(kit.seams.applied[0]?.cause).toBe('connection');
  });

  it('re-pushes even when nothing changed', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    kit.seams.changed = false;
    await refresh(p.id);
    expect(kit.seams.pushes).toEqual([{ passId: p.id, reason: 'refresh' }]);
  });

  it('re-pushes a pass without a connection and fetches nothing', async () => {
    const pass = await makePass(kit, {
      orgId: kit.org.id,
      template: makeTemplate({ id: kit.templateId, orgId: kit.org.id }).resolved,
    });
    await refresh(pass.id);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toEqual([{ passId: pass.id, reason: 'refresh' }]);
    expect((await passTimes(pass.id))?.last_refreshed_at).toBe(kit.clock.now());
  });

  it.each(['auth', 'timeout', 'upstream'])(
    'still re-pushes when the upstream fails (%s) and leaves the pass untouched',
    async (fail) => {
      const dto = await createDemo(kit, { config: { count: 2, fail }, onMissing: 'void' });
      const p = await linkedPass(kit, dto.id, 'm-001');
      await refresh(p.id);
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.missing).toEqual([]);
      expect(kit.seams.pushes).toHaveLength(1);
      const r = await first<{ outcome: string; error_code: string }>(
        kit.env.DB,
        'SELECT outcome, error_code FROM connection_runs WHERE pass_id = ?',
        [p.id],
      );
      expect(r?.outcome).toBe('error');
      // A per-pass refresh never moves connection health or the breaker.
      const conn = await getConnection(kit.env.DB, dto.id);
      expect(conn).toMatchObject({ consecutiveFailures: 0, health: 'unknown' });
    },
  );

  it('applies on_missing when the record is gone upstream', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2, missing: ['m-001'] },
      onMissing: 'flag',
    });
    const p = await linkedPass(kit, dto.id, 'm-001');
    await refresh(p.id);
    expect(kit.seams.missing).toEqual([{ passId: p.id, mode: 'flag' }]);
    expect(kit.seams.pushes).toHaveLength(1);
  });

  it('re-pushes while the breaker is open but rejects a disabled connection', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    await run(kit.env.DB, 'UPDATE connections SET breaker_open_until = ? WHERE id = ?', [
      kit.clock.now() + 60_000,
      dto.id,
    ]);
    await refresh(p.id);
    await run(kit.env.DB, 'UPDATE connections SET breaker_open_until = NULL WHERE id = ?', [
      dto.id,
    ]);
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    await refresh(p.id);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toHaveLength(1);
    const runs = await all<{ outcome: string; error_code: string }>(
      kit.env.DB,
      'SELECT outcome, error_code FROM connection_runs WHERE pass_id = ? ORDER BY id',
      [p.id],
    );
    expect(runs.map((r) => r.error_code)).toEqual(['BREAKER_OPEN']);
  });

  it('does not use a connection from another org', async () => {
    const other = await makeOrg(kit);
    const foreign = await createDemo(kit, { orgId: other.id, config: { count: 2 } });
    const p = await linkedPass(kit, foreign.id, 'm-001');
    await refresh(p.id);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toHaveLength(0);
  });

  it('does nothing for an unknown pass', async () => {
    const pass = await makePass(kit, {
      orgId: kit.org.id,
      template: makeTemplate({ id: kit.templateId, orgId: kit.org.id }).resolved,
    });
    await handlePassRefresh({ ...(await snapshot(pass.id)), passId: 'no-such-pass' }, kit.sctx);
    expect(kit.seams.pushes).toEqual([]);
  });

  it('rethrows a failed push so the queue retries, without stamping last_refreshed_at', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    kit.seams.changed = false;
    kit.seams.failPush = true;
    await expect(refresh(p.id)).rejects.toThrow('push down');
    expect((await passTimes(p.id))?.last_refreshed_at).toBeNull();
  });

  it('suppresses catch-up when applying the record throws with unknown effect', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    setDeps({
      applyConnectionRecord: async () => {
        throw new Error('db down');
      },
    });
    await refresh(p.id);
    expect(kit.seams.pushes).toEqual([]);
    const r = await first<{ outcome: string; error_code: string }>(
      kit.env.DB,
      'SELECT outcome, error_code FROM connection_runs WHERE pass_id = ?',
      [p.id],
    );
    // The failure keeps its real code even though the snapshot is dropped.
    expect(r).toEqual({ outcome: 'error', error_code: 'INTERNAL' });
  });

  it('rejects a preexisting Test binding before fetching or changing the pass', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001', kit.org.id, 'test');
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    await refresh(pass.id);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.missing).toEqual([]);
    expect(kit.seams.pushes).toEqual([]);
  });

  it('does not permit a queued pass to change mode in place', async () => {
    const dto = await createDemo(kit);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    await expect(
      run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]),
    ).rejects.toThrow();
  });

  it.each([
    ['version', 'UPDATE passes SET version = version + 1 WHERE id = ?', false],
    [
      'holder generation',
      'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?',
      false,
    ],
    [
      'lifecycle generation',
      'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
      false,
    ],
    ['reference', "UPDATE passes SET external_ref = 'm-002' WHERE id = ?", false],
    ['unbound', 'UPDATE passes SET connection_id = NULL, external_ref = NULL WHERE id = ?', false],
    ['voided', "UPDATE passes SET status = 'voided' WHERE id = ?", false],
    ['deleted', 'UPDATE passes SET deleted_at = 1 WHERE id = ?', false],
    ['removed', 'UPDATE passes SET removed_at = 1 WHERE id = ?', false],
    ['quarantine', 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', false],
    ['connection mode', "UPDATE connections SET mode = 'poll' WHERE id = ?", true],
    ['generation', 'UPDATE connections SET generation = generation + 1 WHERE id = ?', true],
    ['disabled', 'UPDATE connections SET enabled = 0 WHERE id = ?', true],
  ] as const)(
    'rejects a queued refresh after %s changes without fetching or writing',
    async (_label, sql, connection) => {
      const requests: string[] = [];
      setDeps({
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Live' }));
        }) as typeof fetch,
      });
      const dto = await createDemo(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com' },
        mode: 'manual',
      } as never);
      const pass = await linkedPass(kit, dto.id, 'm-001');
      const job = await snapshot(pass.id);
      await run(kit.env.DB, sql, [connection ? dto.id : pass.id]);
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      await handlePassRefresh(job, kit.sctx);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        before,
      );
      expect(requests).toEqual([]);
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.pushes).toEqual([]);
    },
  );

  it('denies both pre-transfer and fresh-epoch jobs while a transfer is pending', async () => {
    const requests: string[] = [];
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'manual',
    } as never);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const beforeTransfer = await snapshot(pass.id);
    await startPendingTransfer(kit.sctx, pass.id);
    const duringTransfer = await snapshot(pass.id);
    expect(duringTransfer.credentialGeneration).toBeGreaterThan(
      beforeTransfer.credentialGeneration,
    );
    setDeps({
      fetchImpl: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ memberName: 'Live' }));
      }) as typeof fetch,
    });
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    await handlePassRefresh(beforeTransfer, kit.sctx);
    await handlePassRefresh(duringTransfer, kit.sctx);
    expect(requests).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toEqual([]);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(outbox);
  });

  it.each(['missing', 'changed'] as const)(
    'rejects a queued refresh when its keyset singleton is %s before dispatch',
    async (change) => {
      const requests: string[] = [];
      const dto = await createDemo(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com' },
        mode: 'manual',
      } as never);
      const pass = await linkedPass(kit, dto.id, 'm-001');
      const job = await snapshot(pass.id);
      const replacement =
        job.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
        pass.id,
      ]);
      setDeps({
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Live' }));
        }) as typeof fetch,
      });
      try {
        await replaceKeysetForTest(kit.sctx, change === 'missing' ? null : replacement);
        await handlePassRefresh(job, kit.sctx);
        expect(requests).toEqual([]);
        expect(kit.seams.applied).toEqual([]);
        expect(kit.seams.pushes).toEqual([]);
        expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
          before,
        );
        expect(
          await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
        ).toEqual(outbox);
        expect(
          await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
        ).toEqual(change === 'missing' ? null : { commitment: replacement });
      } finally {
        await replaceKeysetForTest(kit.sctx, job.credentialKeysetCommitment);
      }
    },
  );

  it.each(['missing', 'changed'] as const)(
    'does not apply or push when the keyset singleton is %s during fetch',
    async (change) => {
      const dto = await createDemo(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com' },
        mode: 'manual',
      } as never);
      const pass = await linkedPass(kit, dto.id, 'm-001');
      const job = await snapshot(pass.id);
      const replacement =
        job.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
        pass.id,
      ]);
      let requests = 0;
      setDeps({
        fetchImpl: (async () => {
          requests++;
          await replaceKeysetForTest(kit.sctx, change === 'missing' ? null : replacement);
          return new Response(JSON.stringify({ memberName: 'Live' }));
        }) as typeof fetch,
      });
      try {
        await handlePassRefresh(job, kit.sctx);
        expect(requests).toBe(1);
        expect(kit.seams.applied).toEqual([]);
        expect(kit.seams.pushes).toEqual([]);
        expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
          before,
        );
        expect(
          await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
        ).toEqual(outbox);
        expect(
          await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
        ).toEqual(change === 'missing' ? null : { commitment: replacement });
      } finally {
        await replaceKeysetForTest(kit.sctx, job.credentialKeysetCommitment);
      }
    },
  );

  it('fails closed on an old job with no snapshot', async () => {
    const dto = await createDemo(kit);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    await handlePassRefresh(
      { kind: 'pass.refresh', passId: pass.id, trigger: 'user', actorId: 'u1' } as never,
      kit.sctx,
    );
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toEqual([]);
    expect((await passTimes(pass.id))?.last_refreshed_at).toBeNull();
  });

  it('acknowledges old and malformed queue messages without dispatching them', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'manual',
    } as never);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const current = await snapshot(pass.id);
    const bodies: unknown[] = [
      { kind: 'pass.refresh', passId: pass.id, trigger: 'user', actorId: 'u1' },
      { ...current, identityId: undefined },
      { ...current, credentialGeneration: undefined },
      { ...current, credentialGeneration: '1' },
      { ...current, lifecycleGeneration: undefined },
      { ...current, lifecycleGeneration: -1 },
      { ...current, templateId: undefined },
      { ...current, templateVersion: undefined },
      { ...current, releaseId: undefined },
      { ...current, connectionMode: undefined },
      { ...current, connectionMode: 'not-a-mode' },
      { ...current, credentialKeysetCommitment: undefined },
      { ...current, credentialKeysetCommitment: 'not-a-commitment' },
    ];
    const requests: string[] = [];
    setDeps({
      fetchImpl: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ memberName: 'Live' }));
      }) as typeof fetch,
    });
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    const messages = bodies.map((body, index) => ({
      id: `bad-refresh-${index}`,
      body,
      attempts: 1,
      acked: false,
      retried: false,
      ack() {
        this.acked = true;
      },
      retry() {
        this.retried = true;
      },
    }));
    await handleQueue(
      { queue: JOBS_QUEUE, messages } as unknown as MessageBatch<unknown>,
      kit.env,
      createExecutionContext(),
    );
    expect(messages.every((message) => message.acked && !message.retried)).toBe(true);
    expect(requests).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toEqual([]);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(outbox);
  });

  it.each([
    ['missing identity', { identityId: undefined }],
    ['wrong identity', { identityId: 'different-identity' }],
    ['missing template id', { templateId: undefined }],
    ['wrong template id', { templateId: 'other-template' }],
    ['missing template version', { templateVersion: undefined }],
    ['wrong template version', { templateVersion: 'other-version' }],
    ['missing release id', { releaseId: undefined }],
    ['wrong release id', { releaseId: 'other-release' }],
    ['missing connection mode', { connectionMode: undefined }],
    ['invalid connection mode', { connectionMode: 'not-a-mode' }],
    ['wrong null connection mode', { connectionMode: null }],
    ['wrong connection mode', { connectionMode: 'poll' }],
    ['missing keyset', { credentialKeysetCommitment: undefined }],
    ['null keyset', { credentialKeysetCommitment: null }],
    ['invalid keyset', { credentialKeysetCommitment: 'not-a-commitment' }],
    ['uppercase keyset', { credentialKeysetCommitment: 'A'.repeat(64) }],
    ['wrong keyset', { credentialKeysetCommitment: '0'.repeat(64) }],
    ['wrong credential generation', { credentialGeneration: 2 }],
    ['missing credential generation', { credentialGeneration: undefined }],
    ['null credential generation', { credentialGeneration: null }],
    ['zero credential generation', { credentialGeneration: 0 }],
    ['fractional credential generation', { credentialGeneration: 1.5 }],
    ['string credential generation', { credentialGeneration: '1' }],
    ['missing lifecycle generation', { lifecycleGeneration: undefined }],
    ['null lifecycle generation', { lifecycleGeneration: null }],
    ['negative lifecycle generation', { lifecycleGeneration: -1 }],
    ['fractional lifecycle generation', { lifecycleGeneration: 0.5 }],
    ['string lifecycle generation', { lifecycleGeneration: '0' }],
  ] as const)(
    'denies a refresh with %s before fetch, pass mutation, or outbox',
    async (label, malformed) => {
      const requests: string[] = [];
      const dto = await createDemo(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com' },
        mode: 'manual',
      } as never);
      const pass = await linkedPass(kit, dto.id, 'm-001');
      setDeps({
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Live' }));
        }) as typeof fetch,
      });
      const job = {
        ...(await snapshot(pass.id)),
        ...malformed,
        ...(label === 'wrong keyset'
          ? {
              credentialKeysetCommitment:
                kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
            }
          : {}),
      };
      if (!label.startsWith('wrong ')) expect(JobSchema.safeParse(job).success).toBe(false);
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
        pass.id,
      ]);
      await handlePassRefresh(job as never, kit.sctx);
      expect(requests).toEqual([]);
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.pushes).toEqual([]);
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        before,
      );
      expect(
        await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
      ).toEqual(outbox);
    },
  );

  it.each([
    'identity',
    'credential',
    'lifecycle',
    'pending',
    'missing pending',
    'missing push',
    'invalid push',
    'template id',
    'template version',
    'release id',
    'missing release',
    'keyset',
    'missing keyset',
  ] as const)('does not adopt a changed %s from the mutation result', async (change) => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const apply = getDeps().applyConnectionRecord;
    setDeps({
      applyConnectionRecord: async (...args) => {
        const result = await apply(...args);
        return {
          ...result,
          ...(change === 'identity' ? { identityId: 'other-identity' } : {}),
          ...(change === 'credential'
            ? { credentialGeneration: result.credentialGeneration + 1 }
            : {}),
          ...(change === 'lifecycle'
            ? { lifecycleGeneration: result.lifecycleGeneration + 1 }
            : {}),
          ...(change === 'pending' ? { transferPending: true } : {}),
          ...(change === 'missing pending' ? { transferPending: undefined } : {}),
          ...(change === 'missing push' ? { pushQueued: undefined } : {}),
          ...(change === 'invalid push' ? { pushQueued: 'yes' } : {}),
          ...(change === 'template id' ? { templateId: 'other-template' } : {}),
          ...(change === 'template version' ? { templateVersion: 'other-version' } : {}),
          ...(change === 'release id' ? { releaseId: 'other-release' } : {}),
          ...(change === 'keyset'
            ? {
                credentialKeysetCommitment:
                  result.credentialKeysetCommitment === '0'.repeat(64)
                    ? '1'.repeat(64)
                    : '0'.repeat(64),
              }
            : {}),
          ...(change === 'missing keyset' ? { credentialKeysetCommitment: undefined } : {}),
          ...(change === 'missing release' ? { releaseId: undefined } : {}),
        } as never;
      },
    });
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    await refresh(pass.id);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.pushes).toEqual([]);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(outbox);
  });

  it('stops a generation change during the fetch without applying or pushing', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'manual',
    } as never);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    setDeps({
      fetchImpl: (async () => {
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          dto.id,
        ]);
        return new Response(JSON.stringify({ memberName: 'Live' }));
      }) as typeof fetch,
    });
    await refresh(pass.id);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toEqual([]);
    expect((await passTimes(pass.id))?.last_refreshed_at).toBeNull();
    const row = await first<{ outcome: string; error_code: string }>(
      kit.env.DB,
      'SELECT outcome, error_code FROM connection_runs WHERE pass_id = ?',
      [pass.id],
    );
    expect(row).toEqual({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
  });

  it('stops a connection mode change during fetch without applying or pushing', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'manual',
    } as never);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const job = await snapshot(pass.id);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    let requests = 0;
    setDeps({
      fetchImpl: (async () => {
        requests++;
        await run(kit.env.DB, "UPDATE connections SET mode = 'poll' WHERE id = ?", [dto.id]);
        return new Response(JSON.stringify({ memberName: 'Live' }));
      }) as typeof fetch,
    });
    await handlePassRefresh(job, kit.sctx);
    expect(requests).toBe(1);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toEqual([]);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(outbox);
  });

  it('rejects a standalone refresh carrying a connection mode', async () => {
    const pass = await makePass(kit, {
      orgId: kit.org.id,
      template: makeTemplate({ id: kit.templateId, orgId: kit.org.id }).resolved,
    });
    const job = await snapshot(pass.id);
    expect(job.connectionMode).toBeNull();
    await handlePassRefresh({ ...job, connectionMode: 'poll' }, kit.sctx);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toEqual([]);
    expect((await passTimes(pass.id))?.last_refreshed_at).toBeNull();
  });

  it('preserves catch-up refresh for a standalone Test pass', async () => {
    const pass = await testModePass(kit);
    await refresh(pass.id);
    expect(kit.seams.pushes).toEqual([{ passId: pass.id, reason: 'refresh' }]);
    expect((await passTimes(pass.id))?.last_refreshed_at).toBe(kit.clock.now());
  });
});

describe('scheduling', () => {
  const mine = (created: { params: Record<string, unknown> }[], id: string) =>
    created.filter((c) => c.params.connectionId === id);

  it('starts due, enabled, schedulable connections with a deterministic instance id', async () => {
    const due = await createDemo(kit, { name: 'due' });
    const manual = await createDemo(kit, { name: 'manual', mode: 'manual' });
    const off = await createDemo(kit, { name: 'off' });
    await service.update(kit.sctx, kit.actor, off.id, { enabled: false });
    const later = await createDemo(kit, { name: 'later' });
    await run(kit.env.DB, 'UPDATE connections SET next_run_at = ? WHERE id = ?', [
      kit.clock.now() + 1000,
      later.id,
    ]);
    const { sctx, created } = withWorkflow(kit);

    await schedule(sctx);

    expect(mine(created, due.id)).toHaveLength(1);
    expect(mine(created, manual.id)).toEqual([]);
    expect(mine(created, off.id)).toEqual([]);
    expect(mine(created, later.id)).toEqual([]);
    const conn = await getConnection(kit.env.DB, due.id);
    const id = scheduledInstanceId(conn ?? { id: due.id, nextRunAt: null });
    expect(id).toBe(`sync-${due.id}-${kit.clock.now()}`);
    expect(mine(created, due.id)[0]).toMatchObject({
      id,
      params: {
        runId: id,
        trigger: 'schedule',
        orgId: kit.org.id,
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
      },
    });
    const wf = await first<{ kind: string; status: string; target_id: string; org_id: string }>(
      kit.env.DB,
      'SELECT kind, status, target_id, org_id FROM workflow_runs WHERE instance_id = ?',
      [id],
    );
    expect(wf).toEqual({
      kind: 'connection_sync',
      status: 'queued',
      target_id: due.id,
      org_id: kit.org.id,
    });
    const runRow = await first<{ outcome: string }>(
      kit.env.DB,
      'SELECT outcome FROM connection_runs WHERE id = ?',
      [id],
    );
    expect(runRow?.outcome).toBe('running');
  });

  it('treats an existing instance as started and keeps going', async () => {
    const a = await createDemo(kit, { name: 'a' });
    const b = await createDemo(kit, { name: 'b' });
    const { sctx, created } = withWorkflow(kit, async (options) => {
      if ((options as { params: { connectionId: string } }).params.connectionId === a.id) {
        throw new Error('instance.already_exists');
      }
    });
    await schedule(sctx);
    expect(mine(created, b.id)).toHaveLength(1);
    const rows = await all(kit.env.DB, 'SELECT 1 FROM workflow_runs WHERE target_id = ?', [a.id]);
    expect(rows).toHaveLength(1);
    await schedule(sctx);
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM workflow_runs WHERE target_id = ?', [a.id]),
    ).toHaveLength(1);
  });

  it('retains retryable tracking after a launch failure and retries the same instance', async () => {
    const a = await createDemo(kit, { name: 'a' });
    const b = await createDemo(kit, { name: 'b' });
    const conn = await getConnection(kit.env.DB, a.id);
    if (!conn) throw new Error('Missing due connection');
    const id = scheduledInstanceId(conn);
    const attempts: { id: string; params: Record<string, unknown> }[] = [];
    let fail = true;
    const { sctx, created } = withWorkflow(kit, async (options) => {
      const attempt = options as { id: string; params: Record<string, unknown> };
      if (attempt.params.connectionId === a.id) {
        attempts.push(attempt);
        if (fail) throw new Error('workflow service down');
      }
    });
    await schedule(sctx);
    expect(mine(created, b.id)).toHaveLength(1);
    expect(mine(created, a.id)).toEqual([]);
    const workflow = await first(
      kit.env.DB,
      'SELECT instance_id, kind, org_id, target_id, status, started_at FROM workflow_runs WHERE instance_id = ?',
      [id],
    );
    const connectionRun = await first(
      kit.env.DB,
      'SELECT id, connection_id, trigger, outcome, started_at FROM connection_runs WHERE id = ?',
      [id],
    );
    expect(workflow).toEqual({
      instance_id: id,
      kind: 'connection_sync',
      org_id: kit.org.id,
      target_id: a.id,
      status: 'queued',
      started_at: kit.clock.now(),
    });
    expect(connectionRun).toEqual({
      id,
      connection_id: a.id,
      trigger: 'schedule',
      outcome: 'running',
      started_at: kit.clock.now(),
    });

    fail = false;
    await schedule(sctx);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[1]).toEqual({
      id,
      params: {
        connectionId: a.id,
        orgId: kit.org.id,
        generation: 1,
        trigger: 'schedule',
        runId: id,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
      },
    });
    expect(mine(created, a.id)).toEqual([attempts[1]]);
    expect(
      await first(
        kit.env.DB,
        'SELECT instance_id, kind, org_id, target_id, status, started_at FROM workflow_runs WHERE instance_id = ?',
        [id],
      ),
    ).toEqual(workflow);
    expect(
      await first(
        kit.env.DB,
        'SELECT id, connection_id, trigger, outcome, started_at FROM connection_runs WHERE id = ?',
        [id],
      ),
    ).toEqual(connectionRun);
  });

  it("starts a fresh instance after a suspension closed the slot's run, and only one per slot", async () => {
    const dto = await createDemo(kit);
    const { sctx, created: all } = withWorkflow(kit);
    // D1 outlives a test within the file: look only at this connection.
    const mine = () => all.filter((c) => c.params.connectionId === dto.id);
    await schedule(sctx);
    expect(mine()).toHaveLength(1);
    const params = {
      ...mine()[0]?.params,
      instanceId: mine()[0]?.id,
    } as unknown as SyncRunParams;
    // The run is in flight when the org is suspended: it closes as stale and the schedule does not move.
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    await executeSync(kit.sctx, inlineStep(), params);
    expect(
      await first(kit.env.DB, 'SELECT status FROM workflow_runs WHERE instance_id = ?', [
        params.instanceId,
      ]),
    ).toEqual({ status: 'complete' });
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    expect((await getConnection(kit.env.DB, dto.id))?.nextRunAt).toBeLessThanOrEqual(
      kit.clock.now(),
    );
    await schedule(sctx);
    await schedule(sctx);
    expect(mine()).toHaveLength(2);
    expect(mine()[1]?.id).not.toBe(mine()[0]?.id);
  });

  it('moves on from an instance that never finished', async () => {
    const dto = await createDemo(kit);
    const { sctx } = withWorkflow(kit);
    await schedule(sctx);
    kit.clock.advance(31 * 60_000);
    await schedule(sctx);
    const conn = await getConnection(kit.env.DB, dto.id);
    expect(conn?.nextRunAt).toBe(kit.clock.now() + 60_000);
    expect(conn?.lastErrorCode).toBe('RUN_LOST');
  });

  it.each(['missing', 'changed'] as const)(
    'does not classify an old workflow as RUN_LOST when the keyset is %s',
    async (change) => {
      const dto = await createDemo(kit);
      const { sctx, created } = withWorkflow(kit);
      await schedule(sctx);
      // Connections left by earlier tests in this file may be due too: count only what the change adds.
      const launched = created.length;
      const before = await getConnection(kit.env.DB, dto.id);
      const workflows = await all(kit.env.DB, 'SELECT * FROM workflow_runs WHERE target_id = ?', [
        dto.id,
      ]);
      const runs = await all(kit.env.DB, 'SELECT * FROM connection_runs WHERE connection_id = ?', [
        dto.id,
      ]);
      const other =
        kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      kit.clock.advance(31 * 60_000);
      try {
        await replaceKeysetForTest(kit.sctx, change === 'missing' ? null : other);
        await schedule(sctx);
        expect(await getConnection(kit.env.DB, dto.id)).toEqual(before);
        expect(
          await all(kit.env.DB, 'SELECT * FROM workflow_runs WHERE target_id = ?', [dto.id]),
        ).toEqual(workflows);
        expect(
          await all(kit.env.DB, 'SELECT * FROM connection_runs WHERE connection_id = ?', [dto.id]),
        ).toEqual(runs);
        expect(created).toHaveLength(launched);
        expect(created.filter((c) => c.params.connectionId === dto.id)).toHaveLength(1);
        expect(
          await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
        ).toEqual(change === 'missing' ? null : { commitment: other });
      } finally {
        await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
      }
    },
  );
});

describe('retention', () => {
  async function insertRuns(connectionId: string, count: number, startedAt: (i: number) => number) {
    const statements = Array.from({ length: count }, (_, i) =>
      kit.env.DB.prepare(
        "INSERT INTO connection_runs (id, connection_id, trigger, started_at, outcome) VALUES (?, ?, 'schedule', ?, 'unchanged')",
      ).bind(`r-${connectionId}-${String(i).padStart(5, '0')}`, connectionId, startedAt(i)),
    );
    for (let i = 0; i < statements.length; i += 50)
      await kit.env.DB.batch(statements.slice(i, i + 50));
  }
  const runCount = async (id: string) =>
    (
      await first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM connection_runs WHERE connection_id = ?',
        [id],
      )
    )?.n;

  it('drops runs older than 30 days', async () => {
    const dto = await createDemo(kit);
    const now = kit.clock.now();
    await insertRuns(dto.id, 6, (i) =>
      i < 3 ? now - RUN_RETENTION_MS - 1000 - i : now - 1000 - i,
    );
    await dailyConnections(kit.sctx);
    expect(await runCount(dto.id)).toBe(3);
  });

  it('keeps only the newest 1000 per connection', async () => {
    const a = await createDemo(kit, { name: 'a' });
    const b = await createDemo(kit, { name: 'b' });
    const now = kit.clock.now();
    await insertRuns(a.id, 1010, (i) => now - 10_000 + i);
    await insertRuns(b.id, 5, (i) => now - 10_000 + i);
    await dailyConnections(kit.sctx);
    expect(await runCount(a.id)).toBe(1000);
    expect(await runCount(b.id)).toBe(5);
    const oldest = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM connection_runs WHERE connection_id = ? ORDER BY started_at LIMIT 1',
      [a.id],
    );
    expect(oldest?.id).toBe(`r-${a.id}-00010`);
  });

  it('encrypts and quarantines old legacy webhook work instead of deleting it', async () => {
    const dto = await createDemo(kit);
    const now = kit.clock.now();
    const record = JSON.stringify({ memberName: 'Private legacy member' });
    for (const [event, at] of [
      ['old-empty', now - WEBHOOK_RETENTION_MS - 2],
      ['old', now - WEBHOOK_RETENTION_MS - 1],
      ['new', now - 1000],
    ] as const) {
      await run(
        kit.env.DB,
        'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
        [dto.id, event, at],
      );
      if (event !== 'old-empty') {
        await run(
          kit.env.DB,
          'INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at) VALUES (?, ?, ?, ?, ?)',
          [dto.id, event, 'private-ref-473b', record, at],
        );
      }
    }

    await dailyConnections(kit.sctx);

    expect(
      (
        await all<{ event_id: string }>(
          kit.env.DB,
          'SELECT event_id FROM webhook_events WHERE connection_id = ? ORDER BY event_id',
          [dto.id],
        )
      ).map((row) => row.event_id),
    ).toEqual(['new', 'old', 'old-empty']);
    expect(
      (
        await all<{ event_id: string }>(
          kit.env.DB,
          'SELECT event_id FROM connection_inbox WHERE connection_id = ? ORDER BY event_id',
          [dto.id],
        )
      ).map((row) => row.event_id),
    ).toEqual(['new']);
    const source = await first<{ ciphertext: string; iv: string; wrapped_dek: string }>(
      kit.env.DB,
      `SELECT hex(ciphertext) AS ciphertext, hex(iv) AS iv, hex(wrapped_dek) AS wrapped_dek
       FROM connection_webhook_legacy_sources WHERE connection_id = ? AND event_id = ?`,
      [dto.id, 'old'],
    );
    expect(source?.ciphertext.length).toBeGreaterThan(0);
    expect(source?.iv.length).toBeGreaterThan(0);
    expect(source?.wrapped_dek.length).toBeGreaterThan(0);
    expect(source?.ciphertext).not.toContain('50726976617465206C6567616379206D656D626572');
    expect(await sealLegacyWebhookInbox(kit.sctx, dto.id, kit.org.id, 'old')).toEqual([
      { ref: 'private-ref-473b', record: { memberName: 'Private legacy member' }, deleted: false },
    ]);
    expect(
      await first(
        kit.env.DB,
        `SELECT source, state, error_code, snapshot_known FROM connection_webhook_retention
       WHERE connection_id = ? AND event_id = ?`,
        [dto.id, 'old'],
      ),
    ).toEqual({
      source: 'legacy_cleanup_unproven',
      state: 'failed',
      error_code: 'WEBHOOK_LEGACY_UNCERTAIN',
      snapshot_known: 0,
    });
    expect(
      await first(
        kit.env.DB,
        `SELECT source, state, error_code, snapshot_known FROM connection_webhook_retention
       WHERE connection_id = ? AND event_id = ?`,
        [dto.id, 'old-empty'],
      ),
    ).toEqual({
      source: 'legacy_cleanup_unproven',
      state: 'failed',
      error_code: 'WEBHOOK_LEGACY_UNCERTAIN',
      snapshot_known: 0,
    });
    const markers = await all(
      kit.env.DB,
      `SELECT event_id, source, state, error_code, ref_hash, hex(ciphertext) AS ciphertext
       FROM connection_webhook_retention WHERE connection_id = ? ORDER BY event_id`,
      [dto.id],
    );
    expect(JSON.stringify(markers)).not.toContain('private-ref-473b');
    expect(JSON.stringify(markers)).not.toContain('Private legacy member');
    await dailyConnections(kit.sctx);
    expect(
      await all(
        kit.env.DB,
        `SELECT event_id, source, state, error_code, ref_hash, hex(ciphertext) AS ciphertext
       FROM connection_webhook_retention WHERE connection_id = ? ORDER BY event_id`,
        [dto.id],
      ),
    ).toEqual(markers);
    expect(
      await first(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM connection_webhook_legacy_sources WHERE connection_id = ?',
        [dto.id],
      ),
    ).toEqual({ n: 1 });
  }, 60_000);

  it('cleans completed retained events but preserves unresolved and plaintext legacy work', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'webhook-push',
      config: {},
      mode: 'webhook',
    } as never);
    const cutoff = kit.clock.now() - WEBHOOK_RETENTION_MS;
    const secret = dto.webhookSecret as string;
    for (const [eventId, state] of [
      ['resolved', 'resolved'],
      ['failed', 'failed'],
      ['resolved-with-plaintext', 'resolved'],
    ] as const) {
      const body = JSON.stringify({
        id: eventId,
        records: [{ ref: 'r', record: { memberName: 'Retained' } }],
      });
      const ts = Math.floor(kit.clock.now() / 1000);
      await receiveWebhook(
        kit.sctx,
        dto.id,
        new Request('https://wallet.test/h', {
          method: 'POST',
          body,
          headers: {
            'x-wallet-timestamp': String(ts),
            'x-wallet-signature': await signWebhook(secret, ts, body),
          },
        }),
      );
      await run(
        kit.env.DB,
        'UPDATE webhook_events SET received_at = ? WHERE connection_id = ? AND event_id = ?',
        [cutoff - 1, dto.id, eventId],
      );
      await run(
        kit.env.DB,
        `UPDATE connection_webhook_retention SET state = ?, received_at = ?, updated_at = ?
         WHERE connection_id = ? AND event_id = ?`,
        [state, cutoff - 1, cutoff - 1, dto.id, eventId],
      );
      if (state === 'resolved') {
        await run(
          kit.env.DB,
          `UPDATE connection_webhook_items SET state = 'success'
           WHERE retention_id IN (
             SELECT id FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?
           )`,
          [dto.id, eventId],
        );
      }
    }
    await run(
      kit.env.DB,
      'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
      [dto.id, 'legacy-no-retention', cutoff - 1],
    );
    for (const eventId of ['legacy-no-retention', 'resolved-with-plaintext']) {
      await run(
        kit.env.DB,
        'INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at) VALUES (?, ?, ?, ?, ?)',
        [dto.id, eventId, 'private-ref', JSON.stringify({ memberName: 'Private' }), cutoff - 1],
      );
    }

    await deleteOldWebhookEvents(kit.sctx, cutoff);

    expect(
      (
        await all<{ event_id: string }>(
          kit.env.DB,
          'SELECT event_id FROM webhook_events WHERE connection_id = ? ORDER BY event_id',
          [dto.id],
        )
      ).map((row) => row.event_id),
    ).toEqual(['failed', 'legacy-no-retention', 'resolved-with-plaintext']);
    expect(
      (
        await all<{ event_id: string }>(
          kit.env.DB,
          'SELECT event_id FROM connection_inbox WHERE connection_id = ? ORDER BY event_id',
          [dto.id],
        )
      ).map((row) => row.event_id),
    ).toEqual(['legacy-no-retention', 'resolved-with-plaintext']);
    expect(
      await all(
        kit.env.DB,
        'SELECT event_id, state FROM connection_webhook_retention WHERE connection_id = ? ORDER BY event_id',
        [dto.id],
      ),
    ).toEqual([
      { event_id: 'failed', state: 'failed' },
      { event_id: 'resolved-with-plaintext', state: 'resolved' },
    ]);
  }, 60_000);

  it('keeps a resolved legacy marker so an unseen sibling can still be staged after daily cleanup', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
      mode: 'hybrid',
    } as never);
    const eventId = 'legacy-chunks-with-unknown-total';
    const cutoff = kit.clock.now() - WEBHOOK_RETENTION_MS;
    await run(
      kit.env.DB,
      'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
      [dto.id, eventId, cutoff - 1],
    );
    const original: JobOf<'connection.webhook'> = {
      kind: 'connection.webhook',
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      eventId,
      refs: ['first-ref'],
    };
    await retainLegacyQueuedWebhook(kit.sctx, {
      kind: 'connection.webhook',
      connectionId: dto.id,
      eventId,
      refs: original.refs,
    });
    const firstChunk = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
      [dto.id, eventId],
    );
    if (!firstChunk) throw new Error('Missing first legacy chunk');
    await run(
      kit.env.DB,
      "UPDATE connection_webhook_items SET state = 'success', error_code = NULL WHERE retention_id = ?",
      [firstChunk.id],
    );
    await run(
      kit.env.DB,
      "UPDATE connection_webhook_retention SET state = 'resolved', error_code = NULL, received_at = ?, updated_at = ? WHERE id = ?",
      [cutoff - 1, cutoff - 1, firstChunk.id],
    );

    await dailyConnections(kit.sctx);
    expect(
      await first(
        kit.env.DB,
        'SELECT event_id FROM webhook_events WHERE connection_id = ? AND event_id = ?',
        [dto.id, eventId],
      ),
    ).toEqual({ event_id: eventId });
    expect(
      await first(kit.env.DB, 'SELECT state FROM connection_webhook_retention WHERE id = ?', [
        firstChunk.id,
      ]),
    ).toEqual({ state: 'resolved' });

    await retainLegacyQueuedWebhook(kit.sctx, {
      kind: 'connection.webhook',
      connectionId: dto.id,
      eventId,
      refs: ['unseen-ref'],
    });
    expect(
      await all(
        kit.env.DB,
        `SELECT source, state, error_code FROM connection_webhook_retention
       WHERE connection_id = ? AND event_id = ? ORDER BY received_at`,
        [dto.id, eventId],
      ),
    ).toEqual([
      { source: 'legacy', state: 'resolved', error_code: null },
      { source: 'legacy', state: 'ignored', error_code: 'WEBHOOK_LEGACY_JOB' },
    ]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  }, 60_000);

  it.each(['missing', 'conflicting', 'complete'] as const)(
    'deletes an old ingress marker only with %s chunk-count evidence',
    async (scenario) => {
      const dto = await createDemo(kit, {
        connectorType: 'webhook-push',
        config: {},
        mode: 'webhook',
      } as never);
      const cutoff = kit.clock.now() - WEBHOOK_RETENTION_MS;
      const body = JSON.stringify({
        id: 'chunk-completeness',
        records: Array.from({ length: 21 }, (_, index) => ({
          ref: `ref-${index}`,
          record: { memberName: `Member ${index}` },
        })),
      });
      const timestamp = Math.floor(kit.clock.now() / 1000);
      await receiveWebhook(
        kit.sctx,
        dto.id,
        new Request('https://wallet.test/h', {
          method: 'POST',
          body,
          headers: {
            'x-wallet-timestamp': String(timestamp),
            'x-wallet-signature': await signWebhook(dto.webhookSecret as string, timestamp, body),
          },
        }),
      );
      const rows = await all<{ id: string }>(
        kit.env.DB,
        'SELECT id FROM connection_webhook_retention WHERE connection_id = ? ORDER BY id',
        [dto.id],
      );
      expect(rows).toHaveLength(2);
      const changed = rows[0];
      if (!changed) throw new Error('Missing staged chunk');
      await run(kit.env.DB, 'UPDATE webhook_events SET received_at = ? WHERE connection_id = ?', [
        cutoff - 1,
        dto.id,
      ]);
      await run(
        kit.env.DB,
        "UPDATE connection_webhook_retention SET state = 'resolved', received_at = ?, updated_at = ? WHERE connection_id = ?",
        [cutoff - 1, cutoff - 1, dto.id],
      );
      await run(
        kit.env.DB,
        `UPDATE connection_webhook_items SET state = 'success'
        WHERE retention_id IN (SELECT id FROM connection_webhook_retention WHERE connection_id = ?)`,
        [dto.id],
      );
      if (scenario === 'missing') {
        await run(kit.env.DB, 'DELETE FROM connection_webhook_retention WHERE id = ?', [
          changed.id,
        ]);
      } else if (scenario === 'conflicting') {
        await run(
          kit.env.DB,
          'UPDATE connection_webhook_retention SET chunk_count = 3 WHERE id = ?',
          [changed.id],
        );
      }

      expect(await deleteOldWebhookEvents(kit.sctx, cutoff)).toBe(scenario === 'complete' ? 1 : 0);
      const marker = await first(
        kit.env.DB,
        'SELECT event_id FROM webhook_events WHERE connection_id = ? AND event_id = ?',
        [dto.id, 'chunk-completeness'],
      );
      expect(marker).toEqual(scenario === 'complete' ? null : { event_id: 'chunk-completeness' });
      expect(
        await first(
          kit.env.DB,
          'SELECT COUNT(*) AS n FROM connection_webhook_retention WHERE connection_id = ?',
          [dto.id],
        ),
      ).toEqual({ n: scenario === 'complete' ? 0 : scenario === 'missing' ? 1 : 2 });
    },
    60_000,
  );

  it('drains old legacy work in bounded batches without deleting delayed events', async () => {
    const dto = await createDemo(kit);
    const { sctx } = withWorkflow(kit);
    const now = kit.clock.now();
    const cutoff = now - WEBHOOK_RETENTION_MS;
    await claim(kit.env.DB, 'retention:connections', Math.floor(now / 86_400_000) * 86_400_000);
    for (let i = 0; i < 45; i++) {
      const eventId = `backlog-${String(i).padStart(2, '0')}`;
      await run(
        kit.env.DB,
        'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
        [dto.id, eventId, cutoff - i - 1],
      );
      await run(
        kit.env.DB,
        'INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at) VALUES (?, ?, ?, ?, ?)',
        [
          dto.id,
          eventId,
          `ref-${i}`,
          JSON.stringify({ memberName: `Member ${i}` }),
          cutoff - i - 1,
        ],
      );
    }
    const counts = async () => ({
      events: await first(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM webhook_events WHERE connection_id = ?',
        [dto.id],
      ),
      plaintext: await first(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM connection_inbox WHERE connection_id = ?',
        [dto.id],
      ),
      sources: await first(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM connection_webhook_legacy_sources WHERE connection_id = ?',
        [dto.id],
      ),
      markers: await first(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM connection_webhook_retention WHERE connection_id = ?',
        [dto.id],
      ),
    });

    await quarantineLegacyWebhookEvents(kit.sctx, cutoff);
    expect(await counts()).toEqual({
      events: { n: 45 },
      plaintext: { n: 25 },
      sources: { n: 20 },
      markers: { n: 20 },
    });
    await deleteOldWebhookEvents(kit.sctx, cutoff);
    expect((await counts()).events).toEqual({ n: 45 });
    await reconcileConnections(sctx);
    expect(await counts()).toEqual({
      events: { n: 45 },
      plaintext: { n: 5 },
      sources: { n: 40 },
      markers: { n: 40 },
    });
    kit.clock.advance(60_000);
    await reconcileConnections(sctx);
    expect(await counts()).toEqual({
      events: { n: 45 },
      plaintext: { n: 0 },
      sources: { n: 45 },
      markers: { n: 45 },
    });
    await quarantineLegacyWebhookEvents(kit.sctx, kit.clock.now() - WEBHOOK_RETENTION_MS);
    expect(await counts()).toEqual({
      events: { n: 45 },
      plaintext: { n: 0 },
      sources: { n: 45 },
      markers: { n: 45 },
    });
  }, 60_000);

  it.each(['connection_webhook_legacy_sources', 'connection_webhook_retention'] as const)(
    'preserves legacy work and logs no private data when writing %s fails',
    async (table) => {
      const dto = await createDemo(kit);
      const { sctx } = withWorkflow(kit);
      const now = kit.clock.now();
      const cutoff = now - WEBHOOK_RETENTION_MS;
      const eventId = 'private-event-failure-473b';
      const ref = 'private-ref-failure-473b';
      const record = JSON.stringify({ memberName: 'Private failure payload 473b' });
      await run(
        kit.env.DB,
        'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
        [dto.id, eventId, cutoff - 1],
      );
      await run(
        kit.env.DB,
        'INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at) VALUES (?, ?, ?, ?, ?)',
        [dto.id, eventId, ref, record, cutoff - 1],
      );
      const matcher = new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, 'i');
      let failures = 0;
      const db = new Proxy(kit.env.DB, {
        get(target, property) {
          if (property === 'prepare') {
            return (sql: string) => {
              if (matcher.test(sql)) {
                failures += 1;
                throw new Error('Private persistence error 473b');
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const logs: string[] = [];
      const faulty = {
        ...sctx,
        env: { ...sctx.env, DB: db },
        log: createLogger(
          {},
          {
            sink: (line) => {
              logs.push(line);
            },
          },
        ),
      };

      // The failing event is logged and skipped; the other retention steps still run.
      await dailyConnections(faulty);
      expect(failures).toBeGreaterThan(0);
      await deleteOldWebhookEvents(kit.sctx, cutoff);
      expect(
        await first(
          kit.env.DB,
          'SELECT event_id FROM webhook_events WHERE connection_id = ? AND event_id = ?',
          [dto.id, eventId],
        ),
      ).toEqual({ event_id: eventId });
      expect(
        await first(
          kit.env.DB,
          'SELECT ref, record FROM connection_inbox WHERE connection_id = ? AND event_id = ?',
          [dto.id, eventId],
        ),
      ).toEqual({ ref, record });
      const encrypted = await all<{ ciphertext: string }>(
        kit.env.DB,
        `SELECT hex(ciphertext) AS ciphertext FROM connection_webhook_legacy_sources
         WHERE connection_id = ? AND event_id = ?`,
        [dto.id, eventId],
      );
      if (table === 'connection_webhook_legacy_sources') {
        expect(encrypted).toEqual([]);
      } else {
        expect(encrypted.every((row) => row.ciphertext.length > 0)).toBe(true);
        expect(encrypted.every((row) => !row.ciphertext.includes('50726976617465'))).toBe(true);
      }
      expect(
        await all(
          kit.env.DB,
          'SELECT id FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
          [dto.id, eventId],
        ),
      ).toEqual([]);

      await claim(kit.env.DB, 'retention:connections', Math.floor(now / 86_400_000) * 86_400_000);
      await expect(reconcileConnections(faulty)).resolves.toBeUndefined();
      expect(logs.some((line) => line.includes('connection.legacy_event_quarantine_failed'))).toBe(
        true,
      );
      const logged = logs.join('\n');
      for (const secret of [
        eventId,
        ref,
        'Private failure payload 473b',
        'Private persistence error 473b',
      ]) {
        expect(logged).not.toContain(secret);
      }
      expect(
        await first(
          kit.env.DB,
          'SELECT event_id FROM webhook_events WHERE connection_id = ? AND event_id = ?',
          [dto.id, eventId],
        ),
      ).toEqual({ event_id: eventId });
      expect(
        await first(
          kit.env.DB,
          'SELECT ref, record FROM connection_inbox WHERE connection_id = ? AND event_id = ?',
          [dto.id, eventId],
        ),
      ).toEqual({ ref, record });
    },
    60_000,
  );

  it('the minute hook runs retention once per day', async () => {
    const dto = await createDemo(kit);
    const { sctx } = withWorkflow(kit);
    kit.clock.advance(3 * 86_400_000 + 123_456);
    const now = kit.clock.now();
    const stale = async () =>
      (
        await first<{ n: number }>(
          kit.env.DB,
          "SELECT COUNT(*) AS n FROM connection_runs WHERE connection_id = ? AND id LIKE 'r-%' AND started_at < ?",
          [dto.id, now - RUN_RETENTION_MS],
        )
      )?.n;
    await insertRuns(dto.id, 2, (i) => now - RUN_RETENTION_MS - 5000 - i);
    await reconcileConnections(sctx);
    expect(await stale()).toBe(0);
    await insertRuns(dto.id, 2, (i) => now - RUN_RETENTION_MS - 5000 - i);
    await reconcileConnections(sctx);
    expect(await stale()).toBe(2);
  });
});
