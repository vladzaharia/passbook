import { describe, expect, it } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { startOne } from './apply-run.ts';
import { dailyChannels, startApplyInstance, sweepChannelApply } from './apply-start.ts';
import { applyKit } from './apply-test-fixtures.ts';

describe('channel apply: start, sweep and retention', () => {
  it('sweeps a pending run whose instance never started, once it is past due and the grace', async () => {
    const t = await applyKit(1);
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    t.created.length = 0;
    const ctx = jobCtxOf(t.kit);
    await sweepChannelApply(ctx);
    expect(t.created).toHaveLength(0);
    t.kit.clock.advance(12 * 60_000 + 1);
    await sweepChannelApply(ctx);
    expect(t.created).toEqual([{ id, params: { runId: id } }]);
  });

  it('ignores an instance that already exists and logs other failures', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const fail = (message: string) =>
      Object.assign(t.kit.env, {
        CHANNEL_APPLY: {
          async create() {
            throw new Error(message);
          },
        },
      });
    fail('instance.already_exists');
    await expect(startApplyInstance(ctx, 'r1')).resolves.toBeUndefined();
    fail('workflows down');
    await expect(startApplyInstance(ctx, 'r1')).resolves.toBeUndefined();
  });

  it('deletes runs finished over 30 days ago, with their marks', async () => {
    const t = await applyKit();
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    await t.work(id).done;
    const ctx = jobCtxOf(t.kit);
    await dailyChannels(ctx);
    expect(await t.runs()).toHaveLength(1);
    t.kit.clock.advance(31 * 86_400_000);
    await dailyChannels(ctx);
    expect(await t.runs()).toHaveLength(0);
    expect(
      await t.count('SELECT COUNT(*) AS n FROM channel_apply_marks WHERE run_id = ?', id),
    ).toBe(0);
  });
});

describe('channel apply: a running run whose instance died', () => {
  const idle = async () => {
    const t = await applyKit(1);
    const id = (await t.saved({ apple: 'off' })).workflowInstanceId as string;
    t.kit.clock.advance(11 * 60_000);
    expect(await startOne(jobCtxOf(t.kit), id)).toBe('started');
    t.kit.clock.advance(11 * 60_000);
    return { t, id, ctx: jobCtxOf(t.kit) };
  };

  it('leaves a run alone while its last instance is alive or it is not idle', async () => {
    const { t, id, ctx } = await idle();
    const mine = () => t.created.filter((c) => c.id.startsWith(id));
    const before = mine().length;
    await sweepChannelApply(ctx);
    expect(mine()).toHaveLength(before);
    expect((await t.runOf(id))?.state).toBe('running');
  });

  it('recreates the next continuation from the cursor when the last instance errored', async () => {
    const { t, id, ctx } = await idle();
    t.instanceStatus.set(id, 'errored');
    await sweepChannelApply(ctx);
    expect(t.created.filter((c) => c.id.startsWith(id)).at(-1)).toEqual({
      id: `${id}-c1`,
      params: { runId: id, cont: 1 },
    });
    // That continuation errors too, and the first one handed off normally before it.
    t.instanceStatus.set(id, 'complete');
    t.instanceStatus.set(`${id}-c1`, 'errored');
    await sweepChannelApply(ctx);
    expect(t.created.filter((c) => c.id.startsWith(id)).at(-1)).toEqual({
      id: `${id}-c2`,
      params: { runId: id, cont: 2 },
    });
    expect((await t.runOf(id))?.state).toBe('running');
  });

  it('fails the run as lost after three failed instances in a row', async () => {
    const { t, id, ctx } = await idle();
    for (const n of ['', '-c1', '-c2']) {
      if (n) t.created.push({ id: `${id}${n}`, params: {} });
      t.instanceStatus.set(`${id}${n}`, 'errored');
    }
    await sweepChannelApply(ctx);
    expect(await t.runOf(id)).toMatchObject({
      state: 'failed',
      error_code: 'CHANNEL_APPLY_RUN_LOST',
    });
  });
});
