import { beforeEach, describe, expect, it } from 'vitest';
import openMigration from '../../../../migrations/0105_connection_run_open.sql?raw';
import { all, first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { ConnectionSync } from '../../workflows/connection-sync.ts';
import { emptyTotals } from './records.ts';
import { getConnection } from './repo.ts';
import { setWorkflowStatus } from './repo-sync.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import { reconcileConnections, startSync } from './schedule.ts';
import { continuationId, handOff, MAX_HANDOFFS, type SyncChain } from './sync-chain.ts';
import { executeSync, type StepLike, type SyncRunParams } from './sync-runner.ts';
import { createDemo, type Kit, linkedPass, makeKit, withWorkflow } from './test-kit.ts';

let kit: Kit;
let RUN = '';
let n = 0;
beforeEach(async () => {
  kit = await makeKit();
  RUN = `run-${kit.org.id.slice(-6)}-${++n}`;
});

type Created = { id: string; params: Record<string, unknown> };

async function demo(count: number) {
  return createDemo(kit, {
    config: { count },
    autoCreate: true,
    defaultTemplateId: kit.templateId,
    mapping: { memberName: { from: '/memberName' } },
  });
}

async function base(connectionId: string): Promise<SyncRunParams> {
  const conn = await getConnection(kit.env.DB, connectionId);
  const params: SyncRunParams = {
    connectionId,
    orgId: kit.org.id,
    generation: conn?.generation ?? 1,
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    trigger: 'schedule',
    runId: RUN,
    instanceId: RUN,
    writeBudget: 15,
  };
  await seedConnectionWorkflow(kit.sctx, params);
  return params;
}

/** Creates fail on a repeated id, like Workflows; the harness then runs each created instance. */
function platform(onStep?: (name: string) => Promise<void>) {
  const ids = new Set<string>();
  const created: Created[] = [];
  const binding = {
    get: async (id: string) => {
      if (!ids.has(id)) throw new Error('instance.not_found');
      return { status: async () => ({ status: 'running' }) };
    },
    create: async (o: Created) => {
      if (ids.has(o.id)) throw new Error('instance.already_exists');
      ids.add(o.id);
      created.push(o);
    },
  };
  const wf = {
    sctx: {
      ...kit.sctx,
      env: { ...kit.env, CONNECTION_SYNC: binding },
    } as unknown as ServiceContext,
    created,
  };
  const names: string[] = [];
  const inner = inlineStep();
  const step: StepLike = {
    sleep: inner.sleep,
    do: async (name, fn) => {
      names.push(name);
      await onStep?.(name);
      return inner.do(name, fn);
    },
  };
  const drain = async (params: SyncRunParams, until = Infinity) => {
    let n = await executeSync(wf.sctx, step, params).then(() => 0);
    for (let i = 0; wf.created.length > i && i < until; i++) {
      const c = wf.created[i] as Created;
      n++;
      await executeSync(wf.sctx, step, {
        ...params,
        chain: c.params.chain as SyncChain,
      });
    }
    return n;
  };
  return { wf, names, step, drain };
}

const runRow = () =>
  first<{
    outcome: string;
    error_code: string | null;
    records_seen: number;
    passes_changed: number;
  }>(
    kit.env.DB,
    'SELECT outcome, error_code, records_seen, passes_changed FROM connection_runs WHERE id = ?',
    [RUN],
  );
const workflowRow = () =>
  first<{ status: string }>(kit.env.DB, 'SELECT status FROM workflow_runs WHERE instance_id = ?', [
    RUN,
  ]);

describe('sync hand-off', () => {
  it('chains instances over one run and sums the totals', async () => {
    const dto = await demo(50);
    const p = await base(dto.id);
    const { wf, drain } = platform();
    await drain(p);
    expect(wf.created.map((c) => c.id)).toEqual([continuationId(RUN, 1), continuationId(RUN, 2)]);
    expect(wf.created.map((c) => (c.params.chain as SyncChain).seq)).toEqual([1, 2]);
    expect(wf.created.every((c) => c.params.runId === RUN)).toBe(true);
    const refs = kit.seams.created.map((c) => c.externalRef);
    expect(refs).toHaveLength(50);
    expect(new Set(refs).size).toBe(50);
    expect(await runRow()).toMatchObject({
      outcome: 'changed',
      error_code: null,
      records_seen: 50,
      passes_changed: 50,
    });
    expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBe('0:50');
    expect(await workflowRow()).toEqual({ status: 'complete' });
  });

  it('keeps the run open until the last instance and resumes at the saved cursor', async () => {
    const dto = await demo(50);
    const p = await base(dto.id);
    const { wf, names, step } = platform();
    await executeSync(wf.sctx, step, p);
    expect(names).toContain('handoff-1');
    expect(names).not.toContain('finish');
    expect(await runRow()).toMatchObject({ outcome: 'running' });
    expect(await workflowRow()).toEqual({ status: 'running' });
    expect(kit.seams.created).toHaveLength(20);
    expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBe('0:20');
    const chain = wf.created[0]?.params.chain as SyncChain;
    expect(chain).toMatchObject({ seq: 1, totals: { seen: 20, created: 20 } });

    const second = platform();
    await executeSync(second.wf.sctx, second.step, { ...p, chain });
    expect(kit.seams.created).toHaveLength(40);
    expect(second.names.filter((n) => /^page-\d+$/.test(n))).toEqual(['page-0', 'page-1']);
  });

  it('does not hand off below the budget', async () => {
    const dto = await demo(25);
    const p = await base(dto.id);
    const { wf, drain } = platform();
    await drain({ ...p, writeBudget: 100 });
    expect(wf.created).toEqual([]);
    expect(await runRow()).toMatchObject({ outcome: 'changed', records_seen: 25 });
  });

  it('a replayed hand-off step finds its instance and creates no second one', async () => {
    const dto = await demo(50);
    const p = await base(dto.id);
    const { wf, step } = platform();
    let replayed = false;
    const replaying: StepLike = {
      sleep: step.sleep,
      do: async (name, fn) => {
        const value = await step.do(name, fn);
        if (name === 'handoff-1' && !replayed) {
          replayed = true;
          // The step ran, then the engine lost its result and ran it again.
          return step.do(name, fn);
        }
        return value;
      },
    };
    await executeSync(wf.sctx, replaying, p);
    expect(replayed).toBe(true);
    expect(wf.created.map((c) => c.id)).toEqual([continuationId(RUN, 1)]);
    expect(await runRow()).toMatchObject({ outcome: 'running' });
  });

  it('a stale generation ends the chain at the next instance', async () => {
    const dto = await demo(50);
    const p = await base(dto.id);
    const { wf, step } = platform();
    await executeSync(wf.sctx, step, p);
    await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
      dto.id,
    ]);
    const chain = wf.created[0]?.params.chain as SyncChain;
    await executeSync(wf.sctx, step, { ...p, chain });
    expect(wf.created).toHaveLength(1);
    expect(kit.seams.created).toHaveLength(20);
    expect(await runRow()).toMatchObject({ outcome: 'skipped', error_code: 'STALE_GENERATION' });
  });

  it('a connection that goes stale at the hand-off creates no instance', async () => {
    const dto = await demo(50);
    const p = await base(dto.id);
    const { wf, step } = platform(async (name) => {
      if (name === 'handoff-1')
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [dto.id]);
    });
    await executeSync(wf.sctx, step, p);
    expect(wf.created).toEqual([]);
    expect(await runRow()).toMatchObject({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
  });

  it('a run already marked lost starts no continuation', async () => {
    const dto = await demo(50);
    const p = await base(dto.id);
    const { wf, step } = platform(async (name) => {
      if (name === 'handoff-1')
        await run(kit.env.DB, "UPDATE workflow_runs SET status = 'errored' WHERE instance_id = ?", [
          RUN,
        ]);
    });
    await executeSync(wf.sctx, step, p);
    expect(wf.created).toEqual([]);
  });

  it.each([
    ['errored', 'RUN_LOST'],
    ['running', null],
  ])('judges a stuck run by its last instance (%s)', async (tip, lost) => {
    const dto = await createDemo(kit);
    const states: Record<string, string> = { '-c1': 'complete', '-c2': tip };
    let root = '';
    const binding = {
      create: async (o: { id: string; params: { connectionId: string } }) => {
        if (o.params.connectionId === dto.id) root ||= o.id;
      },
      get: async (id: string) => {
        const state = id === root ? 'complete' : states[id.slice(root.length)];
        if (!state) throw new Error('instance.not_found');
        return { status: async () => ({ status: state }) };
      },
    };
    const sctx = { ...kit.sctx, env: { ...kit.env, CONNECTION_SYNC: binding } } as never;
    await reconcileConnections(sctx);
    await run(kit.env.DB, 'UPDATE workflow_runs SET tip_seq = 2 WHERE target_id = ?', [dto.id]);
    kit.clock.advance(45 * 60_000);
    await reconcileConnections({ ...(sctx as object), clock: kit.clock } as never);
    expect((await getConnection(kit.env.DB, dto.id))?.lastErrorCode ?? null).toBe(lost);
    const row = await first<{
      outcome: string;
      error_code: string | null;
      finished_at: number | null;
    }>(
      kit.env.DB,
      'SELECT outcome, error_code, finished_at FROM connection_runs WHERE connection_id = ?',
      [dto.id],
    );
    expect(row).toMatchObject(
      lost
        ? { outcome: 'error', error_code: 'RUN_LOST', finished_at: kit.clock.now() }
        : { outcome: 'running', finished_at: null },
    );
  });

  it('stops at the budget when the chain cap is reached, with a visible outcome', async () => {
    const dto = await demo(50);
    const p = await base(dto.id);
    const { wf, step } = platform();
    const chain = {
      seq: MAX_HANDOFFS,
      startedAt: kit.clock.now(),
      totals: emptyTotals(),
      samples: [],
    };
    await executeSync(wf.sctx, step, { ...p, chain });
    expect(wf.created).toEqual([]);
    expect(kit.seams.created).toHaveLength(20);
    expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBe('0:20');
    const row = await first<{ outcome: string; error_detail: string }>(
      kit.env.DB,
      'SELECT outcome, error_detail FROM connection_runs WHERE id = ?',
      [RUN],
    );
    expect(row?.outcome).toBe('changed');
    expect(row?.error_detail).toContain('SYNC_CAPPED');
    expect(await workflowRow()).toEqual({ status: 'complete' });
  });

  it('counts updates toward the budget', async () => {
    const dto = await createDemo(kit, { config: { count: 50 } });
    for (let i = 1; i <= 20; i++) await linkedPass(kit, dto.id, `m-${String(i).padStart(3, '0')}`);
    const p = await base(dto.id);
    const { wf, step } = platform();
    await executeSync(wf.sctx, step, p);
    expect(kit.seams.created).toEqual([]);
    expect(wf.created.map((c) => (c.params.chain as SyncChain).totals)).toEqual([
      expect.objectContaining({ created: 0, changed: 20 }),
    ]);
  });

  it('a replayed hand-off step finds a child that has already finished the run', async () => {
    const dto = await demo(50);
    const p = await base(dto.id);
    const harness = platform();
    await harness.drain(p);
    expect(await runRow()).toMatchObject({ outcome: 'changed' });
    const chain = harness.wf.created[0]?.params.chain as SyncChain;
    const again = await handOff(harness.wf.sctx, { ...p, mode: 'poll' }, chain);
    expect(again).toEqual({ started: true });
    expect(harness.wf.created).toHaveLength(2);
  });

  it('a run marked lost cannot go back to running', async () => {
    const dto = await demo(5);
    const p = await base(dto.id);
    const scope = { orgId: kit.org.id, connectionId: dto.id };
    const set = (status: 'running' | 'errored') =>
      setWorkflowStatus(
        kit.env.DB,
        RUN,
        status,
        kit.clock.now(),
        null,
        undefined,
        kit.credentialKeysetCommitment,
        scope,
      );
    expect(await set('running')).toBe(true);
    expect(await set('errored')).toBe(true);
    expect(await set('running')).toBe(false);
    const { wf, step } = platform();
    await executeSync(wf.sctx, step, p);
    expect(kit.seams.created).toEqual([]);
    expect(await runRow()).toMatchObject({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
  });

  it('adopts a run in flight instead of starting a second one', async () => {
    const dto = await demo(5);
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('no connection');
    const { sctx, created } = withWorkflow(kit, undefined, () => 'running');
    const first = await startSync(sctx, conn, 'admin', 'sync-a-admin-1');
    const second = await startSync(sctx, conn, 'admin', 'sync-a-admin-2');
    expect(second).toEqual(first);
    expect(created.map((c) => c.id)).toEqual(['sync-a-admin-1']);
    kit.clock.advance(45 * 60_000);
    const dead = withWorkflow(kit, undefined, () => 'errored');
    await startSync({ ...dead.sctx, clock: kit.clock }, conn, 'admin', 'sync-a-admin-3');
    expect(dead.created.map((c) => c.id)).toEqual(['sync-a-admin-3']);
  });

  it.each([
    ['maps a continuation id to its run', (id: string) => `${id}-c1`, 1, true],
    ['refuses a continuation id with the wrong seq', (id: string) => `${id}-c2`, 1, false],
    ['refuses a foreign id without a chain', (id: string) => `${id}-c1`, 0, false],
  ])('workflow entrypoint %s', async (_name, instanceOf, seq, ok) => {
    const dto = await demo(5);
    await base(dto.id);
    const wf = Object.assign(Object.create(ConnectionSync.prototype), {
      env: kit.env,
    }) as ConnectionSync;
    const payload = {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      trigger: 'schedule' as const,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      runId: RUN,
      ...(seq
        ? { chain: { seq, startedAt: kit.clock.now(), totals: emptyTotals(), samples: [] } }
        : {}),
    };
    const call = wf.run(
      { payload, instanceId: instanceOf(RUN), timestamp: new Date() } as never,
      inlineStep() as never,
    );
    if (ok) {
      await call;
      expect(await runRow()).toMatchObject({ outcome: 'changed' });
    } else {
      await expect(call).rejects.toThrow();
      expect(await runRow()).toMatchObject({ outcome: 'running' });
    }
  });

  it('opens one run when two enqueues race', async () => {
    const dto = await demo(5);
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('no connection');
    const { sctx, created } = withWorkflow(kit, undefined, () => 'running');
    const [a, b] = await Promise.all([
      startSync(sctx, conn, 'admin', 'sync-r-admin-1'),
      startSync(sctx, conn, 'admin', 'sync-r-admin-2'),
    ]);
    expect(a.runId).toBe(b.runId);
    expect(created).toHaveLength(1);
    const rows = await all(
      kit.env.DB,
      "SELECT 1 FROM connection_runs WHERE connection_id = ? AND outcome = 'running'",
      [dto.id],
    );
    const tracked = await all(kit.env.DB, 'SELECT 1 FROM workflow_runs WHERE target_id = ?', [
      dto.id,
    ]);
    expect([rows.length, tracked.length]).toEqual([1, 1]);
  });

  it('closes a dead admin run when a new one starts', async () => {
    const dto = await demo(5);
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('no connection');
    await startSync(withWorkflow(kit, undefined, () => 'running').sctx, conn, 'admin', 'sync-d-1');
    kit.clock.advance(45 * 60_000);
    const dead = withWorkflow(kit, undefined, () => 'errored');
    await startSync({ ...dead.sctx, clock: kit.clock }, conn, 'admin', 'sync-d-2');
    const old = await first<{ outcome: string; error_code: string }>(
      kit.env.DB,
      "SELECT outcome, error_code FROM connection_runs WHERE id = 'sync-d-1'",
    );
    expect(old).toEqual({ outcome: 'error', error_code: 'RUN_LOST' });
    expect(dead.created.map((c) => c.id)).toEqual(['sync-d-2']);
  });

  it('recovers a retry attempt that died', async () => {
    const dto = await createDemo(kit);
    const states = { current: 'running' };
    const binding = {
      create: async () => undefined,
      get: async () => ({ status: async () => ({ status: states.current }) }),
    };
    const sctx = {
      ...kit.sctx,
      env: { ...kit.env, CONNECTION_SYNC: binding },
    } as unknown as ServiceContext;
    await reconcileConnections(sctx);
    await run(kit.env.DB, "UPDATE workflow_runs SET status = 'complete' WHERE target_id = ?", [
      dto.id,
    ]);
    await reconcileConnections(sctx);
    const attempts = await all<{ instance_id: string }>(
      kit.env.DB,
      "SELECT instance_id FROM workflow_runs WHERE target_id = ? AND status = 'queued'",
      [dto.id],
    );
    expect(attempts).toHaveLength(1);
    states.current = 'errored';
    kit.clock.advance(45 * 60_000);
    await reconcileConnections({ ...sctx, clock: kit.clock });
    const closed = await first<{ outcome: string; error_code: string }>(
      kit.env.DB,
      'SELECT outcome, error_code FROM connection_runs WHERE id = ?',
      [attempts[0]?.instance_id ?? ''],
    );
    expect(closed).toEqual({ outcome: 'error', error_code: 'RUN_LOST' });
  });

  it('starts the instance of an adopted run whose launch failed', async () => {
    const dto = await demo(5);
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('no connection');
    const broken = withWorkflow(kit, async () => {
      throw new Error('launch failed');
    });
    await expect(startSync(broken.sctx, conn, 'admin', 'sync-q-1')).rejects.toThrow(
      'launch failed',
    );
    const ok = withWorkflow(kit);
    const again = await startSync(ok.sctx, conn, 'admin', 'sync-q-2');
    expect(again.runId).toBe('sync-q-1');
    expect(ok.created.map((c) => c.id)).toEqual(['sync-q-1']);
    expect(ok.created[0]?.params).toMatchObject({ runId: 'sync-q-1', trigger: 'admin' });
  });

  it('does not adopt a run enqueued under an older generation', async () => {
    const dto = await demo(5);
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('no connection');
    const broken = withWorkflow(kit, async () => {
      throw new Error('launch failed');
    });
    await expect(startSync(broken.sctx, conn, 'admin', 'sync-g-1')).rejects.toThrow(
      'launch failed',
    );
    await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
      dto.id,
    ]);
    const bumped = await getConnection(kit.env.DB, dto.id);
    if (!bumped) throw new Error('no connection');
    const ok = withWorkflow(kit, undefined, () => 'running');
    const started = await startSync(ok.sctx, bumped, 'admin', 'sync-g-2');
    // The fenced run is closed, and the new one launches under the current generation.
    expect(started.runId).toBe('sync-g-2');
    expect(ok.created[0]?.params).toMatchObject({
      runId: 'sync-g-2',
      generation: bumped.generation,
    });
    expect(
      (
        await first<{ outcome: string }>(
          kit.env.DB,
          'SELECT outcome FROM connection_runs WHERE id = ?',
          ['sync-g-1'],
        )
      )?.outcome,
    ).toBe('error');
  });

  it('still adopts a run enqueued under the current generation', async () => {
    const dto = await demo(5);
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('no connection');
    const { sctx, created } = withWorkflow(kit, undefined, () => 'running');
    await startSync(sctx, conn, 'admin', 'sync-h-1');
    const again = await startSync(sctx, conn, 'admin', 'sync-h-2');
    expect(again.runId).toBe('sync-h-1');
    expect(created.map((c) => c.id)).toEqual(['sync-h-1']);
  });

  describe('pass refreshes are not sync runs', () => {
    const insert = (id: string, connectionId: string, passId: string | null, at: number) =>
      run(
        kit.env.DB,
        `INSERT INTO connection_runs (id, connection_id, trigger, pass_id, started_at, outcome)
         VALUES (?, ?, 'admin', ?, ?, 'running')`,
        [id, connectionId, passId, at],
      );

    it('lets refreshes open during a sync and alongside each other', async () => {
      const dto = await demo(5);
      await insert(`s-${RUN}`, dto.id, null, 1);
      await insert(`r1-${RUN}`, dto.id, 'pass-1', 2);
      await insert(`r2-${RUN}`, dto.id, 'pass-2', 3);
      await expect(insert(`s2-${RUN}`, dto.id, null, 4)).rejects.toThrow();
    });

    it('starts and adopts around refreshes', async () => {
      const dto = await demo(5);
      const conn = await getConnection(kit.env.DB, dto.id);
      if (!conn) throw new Error('no connection');
      await insert(`r1-${RUN}`, dto.id, 'pass-1', kit.clock.now());
      const wf = withWorkflow(kit, undefined, () => 'running');
      await startSync(wf.sctx, conn, 'admin', 'sync-p-1');
      expect(wf.created.map((c) => c.id)).toEqual(['sync-p-1']);
      const refresh = await first<{ outcome: string }>(
        kit.env.DB,
        'SELECT outcome FROM connection_runs WHERE id = ?',
        [`r1-${RUN}`],
      );
      expect(refresh?.outcome).toBe('running');
    });

    it('cleanup keeps the newest sync run and ignores refresh rows', async () => {
      const dto = await demo(5);
      await run(kit.env.DB, 'DROP INDEX connection_runs_open_sync');
      await insert(`old-${RUN}`, dto.id, null, 1);
      await insert(`new-${RUN}`, dto.id, null, 2);
      await insert(`rf-${RUN}`, dto.id, 'pass-1', 3);
      await run(
        kit.env.DB,
        openMigration.slice(openMigration.indexOf('UPDATE'), openMigration.indexOf(';') + 1),
      );
      const create = openMigration.indexOf('CREATE UNIQUE INDEX');
      await run(kit.env.DB, openMigration.slice(create, openMigration.indexOf(';', create) + 1));
      const rows = await all<{ id: string; outcome: string }>(
        kit.env.DB,
        'SELECT id, outcome FROM connection_runs WHERE connection_id = ? ORDER BY started_at',
        [dto.id],
      );
      expect(rows.map((r) => r.outcome)).toEqual(['error', 'running', 'running']);
    });
  });
});
