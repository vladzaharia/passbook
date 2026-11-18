import { beforeEach, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { getConnection } from './repo.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import { reconcileConnections } from './schedule.ts';
import { continuationId, type SyncChain } from './sync-chain.ts';
import { executeSync, type StepLike, type SyncRunParams } from './sync-runner.ts';
import { createDemo, type Kit, makeKit, withWorkflow } from './test-kit.ts';

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
    createBudget: 15,
  };
  await seedConnectionWorkflow(kit.sctx, params);
  return params;
}

/** Creates fail on a repeated id, like Workflows; the harness then runs each created instance. */
function platform(onStep?: (name: string) => Promise<void>) {
  const ids = new Set<string>();
  const wf = withWorkflow(kit, async (o) => {
    const { id } = o as Created;
    if (ids.has(id)) throw new Error('instance.already_exists');
    ids.add(id);
  });
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
    await drain({ ...p, createBudget: 100 });
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
      create: async (o: { id: string }) => {
        root ||= o.id;
      },
      get: async (id: string) => {
        const state = id === root ? 'complete' : states[id.slice(root.length)];
        if (!state) throw new Error('instance.not_found');
        return { status: async () => ({ status: state }) };
      },
    };
    const sctx = { ...kit.sctx, env: { ...kit.env, CONNECTION_SYNC: binding } } as never;
    await reconcileConnections(sctx);
    kit.clock.advance(45 * 60_000);
    await reconcileConnections({ ...(sctx as object), clock: kit.clock } as never);
    expect((await getConnection(kit.env.DB, dto.id))?.lastErrorCode ?? null).toBe(lost);
  });
});
