import { describe, expect, it } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
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
