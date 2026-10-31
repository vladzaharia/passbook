import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import {
  dailyConnections,
  handlePassRefresh,
  RUN_RETENTION_MS,
  reconcileConnections,
  WEBHOOK_RETENTION_MS,
} from './jobs.ts';
import { getConnection } from './repo.ts';
import { reconcileConnections as schedule, scheduledInstanceId } from './schedule.ts';
import * as service from './service.ts';
import { createDemo, type Kit, linkedPass, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

const refresh = (passId: string, trigger: 'user' | 'admin' = 'user') =>
  handlePassRefresh({ kind: 'pass.refresh', passId, trigger, actorId: 'u1' }, kit.sctx);

const passTimes = (id: string) =>
  first<{ last_refreshed_at: number | null }>(
    kit.env.DB,
    'SELECT last_refreshed_at FROM passes WHERE id = ?',
    [id],
  );

describe('pass.refresh', () => {
  it('fetches the record, applies it, then re-pushes and stamps last_refreshed_at', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    kit.clock.advance(5);
    await refresh(p.id);
    expect(kit.seams.applied).toHaveLength(1);
    expect(kit.seams.applied[0]).toMatchObject({
      passId: p.id,
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
    expect(runs).toEqual([{ trigger: 'user', outcome: 'changed', pass_id: p.id, actor_id: 'u1' }]);
  });

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
    const { makePass, makeTemplate } = await import('../../../../test/helpers/index.ts');
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

  it('skips the fetch while the breaker is open or the connection is disabled, but still pushes', async () => {
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
    expect(kit.seams.pushes).toHaveLength(2);
    const runs = await all<{ outcome: string; error_code: string }>(
      kit.env.DB,
      'SELECT outcome, error_code FROM connection_runs WHERE pass_id = ? ORDER BY id',
      [p.id],
    );
    expect(runs.map((r) => r.error_code).sort()).toEqual(['BREAKER_OPEN', 'DISABLED']);
  });

  it('does not use a connection from another org', async () => {
    const other = await makeOrg(kit);
    const foreign = await createDemo(kit, { orgId: other.id, config: { count: 2 } });
    const p = await linkedPass(kit, foreign.id, 'm-001');
    await refresh(p.id);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.pushes).toHaveLength(1);
  });

  it('does nothing for an unknown pass', async () => {
    await refresh('no-such-pass');
    expect(kit.seams.pushes).toEqual([]);
  });

  it('rethrows a failed push so the queue retries, without stamping last_refreshed_at', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    kit.seams.failPush = true;
    await expect(refresh(p.id)).rejects.toThrow('push down');
    expect((await passTimes(p.id))?.last_refreshed_at).toBeNull();
  });

  it('still pushes when applying the record throws, then lets the job retry', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    const { setDeps } = await import('./deps.ts');
    setDeps({
      applyConnectionRecord: async () => {
        throw new Error('db down');
      },
    });
    await refresh(p.id);
    expect(kit.seams.pushes).toHaveLength(1);
    const r = await first<{ outcome: string }>(
      kit.env.DB,
      'SELECT outcome FROM connection_runs WHERE pass_id = ?',
      [p.id],
    );
    expect(r?.outcome).toBe('error');
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
      params: { runId: id, trigger: 'schedule', generation: 1 },
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

  it('logs other failures and carries on with the remaining connections', async () => {
    const a = await createDemo(kit, { name: 'a' });
    const b = await createDemo(kit, { name: 'b' });
    const { sctx, created } = withWorkflow(kit, async (options) => {
      if ((options as { params: { connectionId: string } }).params.connectionId === a.id) {
        throw new Error('workflow service down');
      }
    });
    await schedule(sctx);
    expect(mine(created, b.id)).toHaveLength(1);
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM workflow_runs WHERE target_id = ?', [a.id]),
    ).toEqual([]);
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

  it('drops webhook events (and their inbox rows) after 7 days', async () => {
    const dto = await createDemo(kit);
    const now = kit.clock.now();
    for (const [event, at] of [
      ['old', now - WEBHOOK_RETENTION_MS - 1],
      ['new', now - 1000],
    ] as const) {
      await run(
        kit.env.DB,
        'INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES (?, ?, ?)',
        [dto.id, event, at],
      );
      await run(
        kit.env.DB,
        "INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at) VALUES (?, ?, 'r', '{}', ?)",
        [dto.id, event, at],
      );
    }
    await dailyConnections(kit.sctx);
    expect(
      (
        await all<{ event_id: string }>(
          kit.env.DB,
          'SELECT event_id FROM webhook_events WHERE connection_id = ?',
          [dto.id],
        )
      ).map((e) => e.event_id),
    ).toEqual(['new']);
    expect(
      (
        await all<{ event_id: string }>(
          kit.env.DB,
          'SELECT event_id FROM connection_inbox WHERE connection_id = ?',
          [dto.id],
        )
      ).map((e) => e.event_id),
    ).toEqual(['new']);
  });

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
