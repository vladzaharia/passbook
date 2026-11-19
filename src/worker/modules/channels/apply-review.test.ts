import { describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import * as events from '../events/record.ts';
import { applyChannelPage } from './apply-page.ts';
import { failRun, finishRun, startOne } from './apply-run.ts';
import { sweepChannelApply } from './apply-start.ts';
import { applyKit } from './apply-test-fixtures.ts';
import * as write from './repo-apply-write.ts';

vi.mock('./repo-apply-write.ts', async (original) => {
  const real = await original<typeof import('./repo-apply-write.ts')>();
  return { ...real, writeJournaled: vi.fn(real.writeJournaled) };
});

vi.mock('../events/record.ts', async (original) => {
  const real = await original<typeof import('../events/record.ts')>();
  return { ...real, recordPassEvents: vi.fn(real.recordPassEvents) };
});

const idOf = async (p: Promise<{ workflowInstanceId: string | null }>) =>
  (await p).workflowInstanceId as string;

describe('channel apply: review fixes', () => {
  it('keeps waiting while the run ahead makes progress, however long it takes', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const a = await idOf(t.saved({ apple: 'off' }));
    t.kit.clock.advance(10 * 60_000);
    await startOne(ctx, a);
    const b = await idOf(t.saved({ apple: 'on' }));
    let rounds = 0;
    const w = t.work(b, {
      onSleep: async (name) => {
        if (!name.startsWith('blocked')) return;
        rounds++;
        // The run ahead writes every round for 3 hours (36 rounds of 5 minutes), then ends.
        await t.exec(
          'UPDATE channel_apply_runs SET updated_at = ? WHERE id = ?',
          t.kit.clock.now(),
          a,
        );
        if (rounds === 36) await finishRun(ctx, a);
      },
    });
    expect(await w.done).toEqual({ state: 'done' });
    expect(rounds).toBe(36);
  });

  it('fails the run behind one that stopped making progress', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const a = await idOf(t.saved({ apple: 'off' }));
    t.kit.clock.advance(10 * 60_000);
    await startOne(ctx, a);
    const b = await idOf(t.saved({ apple: 'on' }));
    t.kit.clock.advance(11 * 60_000);
    expect(await t.work(b).done).toEqual({ state: 'failed' });
    expect(await t.runOf(b)).toMatchObject({ error_code: 'CHANNEL_APPLY_PREDECESSOR_STALLED' });
  });

  it('a save after a failed run starts from where the failed run began, and converges', async () => {
    const t = await applyKit(2);
    const ctx = jobCtxOf(t.kit);
    const a = await idOf(t.saved({ apple: 'off' }));
    await failRun(ctx, a, 'CHANNEL_APPLY_FAILED');
    const b = await idOf(t.saved({ mobile: 'off' }));
    expect(await t.runOf(b)).toMatchObject({ from_channels: '{}' });
    expect(await t.work(b).done).toEqual({ state: 'done' });
    expect(await t.retired('apple')).toHaveLength(2);
    expect(await t.retired('mobile')).toHaveLength(2);
  });

  it('applies one shared template to two orgs separately', async () => {
    const t = await applyKit(1);
    const other = await t.otherOrg();
    const a = await idOf(t.saved({ apple: 'off' }));
    await t.work(a).done;
    expect(await t.retired('apple')).toHaveLength(1);
    expect(
      await t.count('SELECT COUNT(*) AS n FROM pass_channels WHERE pass_id = ?', other.pass.id),
    ).toBe(0);
    const b = await idOf(other.save({ mobile: 'off' }));
    expect(b).not.toBe(a);
    await t.work(b).done;
    expect(
      await t.count(
        "SELECT COUNT(*) AS n FROM pass_channels WHERE pass_id = ? AND channel = 'mobile' AND retired_at IS NOT NULL",
        other.pass.id,
      ),
    ).toBe(1);
    expect(
      await t.count(
        "SELECT COUNT(*) AS n FROM pass_channels WHERE channel = 'mobile' AND pass_id = ?",
        t.ids[0] ?? '',
      ),
    ).toBe(0);
  });

  it('recreates a lost instance up to three times, then fails the run as lost', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const id = await idOf(t.saved({ apple: 'off' }));
    t.kit.clock.advance(15 * 60_000);
    await sweepChannelApply(ctx);
    expect(t.created.map((c) => c.id)).toEqual([id]);
    const ids = [id, `${id}-r1`, `${id}-r2`, `${id}-r3`];
    for (const [i, instance] of ids.entries()) {
      t.instanceStatus.set(instance, 'errored');
      await sweepChannelApply(ctx);
      if (i < 3) expect(t.created.at(-1)).toEqual({ id: ids[i + 1], params: { runId: id } });
    }
    expect(t.created).toHaveLength(4);
    expect(await t.runOf(id)).toMatchObject({
      state: 'failed',
      error_code: 'CHANNEL_APPLY_RUN_LOST',
    });
  });

  it('does not sweep a pending run queued behind a running one', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const a = await idOf(t.saved({ apple: 'off' }));
    t.kit.clock.advance(10 * 60_000);
    await startOne(ctx, a);
    await t.saved({ apple: 'on' });
    t.created.length = 0;
    t.kit.clock.advance(20 * 60_000);
    await sweepChannelApply(ctx);
    expect(t.created).toHaveLength(0);
  });

  it('replays a journal that crashed between the ledger and the mark without repeating events', async () => {
    const t = await applyKit(3);
    const ctx = jobCtxOf(t.kit);
    const id = await idOf(t.saved({ apple: 'off' }));
    await startOne(ctx, id);
    vi.mocked(write.writeJournaled).mockRejectedValueOnce(new Error('crash'));
    await expect(applyChannelPage(ctx, id)).rejects.toThrow('crash');
    expect(await t.feed()).toBe(3);
    expect(await applyChannelPage(ctx, id)).toEqual({ done: true });
    expect(await t.feed()).toBe(3);
    expect(
      await t.count(
        'SELECT COUNT(*) AS n FROM channel_apply_marks WHERE run_id = ? AND journaled_at IS NULL',
        id,
      ),
    ).toBe(0);
  });

  it('journals the marks of a run that fails, so no event is lost', async () => {
    const t = await applyKit(2);
    const ctx = jobCtxOf(t.kit);
    const id = await idOf(t.saved({ apple: 'off' }));
    await startOne(ctx, id);
    // The page crashes before anything reaches the ledger.
    vi.mocked(events.recordPassEvents).mockRejectedValueOnce(new Error('crash'));
    await expect(applyChannelPage(ctx, id)).rejects.toThrow('crash');
    expect(await t.feed()).toBe(0);
    await failRun(ctx, id, 'CHANNEL_APPLY_FAILED');
    expect(await t.feed()).toBe(2);
    expect(await t.runOf(id)).toMatchObject({ state: 'failed' });
  });

  it('fails and journals a run whose org was suspended mid-page', async () => {
    const t = await applyKit(2);
    const ctx = jobCtxOf(t.kit);
    const id = await idOf(t.saved({ apple: 'off' }));
    await startOne(ctx, id);
    vi.mocked(events.recordPassEvents).mockRejectedValueOnce(new Error('crash'));
    await expect(applyChannelPage(ctx, id)).rejects.toThrow('crash');
    await t.exec("UPDATE orgs SET status = 'suspended' WHERE id = ?", t.orgId);
    await failRun(ctx, id, 'CHANNEL_APPLY_ORG_INACTIVE');
    expect(await t.runOf(id)).toMatchObject({ state: 'failed' });
    expect(
      await t.count(
        "SELECT COUNT(*) AS n FROM pass_events WHERE kind = 'pass.channels_changed' AND json_extract(data, '$.runId') = ?",
        id,
      ),
    ).toBe(2);
    expect(
      await t.count(
        'SELECT COUNT(*) AS n FROM channel_apply_marks WHERE run_id = ? AND journaled_at IS NULL',
        id,
      ),
    ).toBe(0);
  });

  it('waits past 300 rounds while the run ahead makes progress', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const a = await idOf(t.saved({ apple: 'off' }));
    t.kit.clock.advance(10 * 60_000);
    await startOne(ctx, a);
    const b = await idOf(t.saved({ apple: 'on' }));
    let rounds = 0;
    const w = t.work(b, {
      onSleep: async (name) => {
        if (!name.startsWith('blocked')) return;
        rounds++;
        await t.exec(
          'UPDATE channel_apply_runs SET updated_at = ? WHERE id = ?',
          t.kit.clock.now(),
          a,
        );
        if (rounds === 320) await finishRun(ctx, a);
      },
    });
    expect(await w.done).toEqual({ state: 'done' });
    expect(rounds).toBe(320);
  });

  it('a run that fails with its successor pending hands the failed range to the successor', async () => {
    const t = await applyKit(2);
    const ctx = jobCtxOf(t.kit);
    const a = await idOf(t.saved({ apple: 'off' }));
    t.kit.clock.advance(10 * 60_000);
    await startOne(ctx, a);
    await applyChannelPage(ctx, a);
    expect(await t.retired('apple')).toHaveLength(2);
    // The save back to on opens a pending run whose raw from is the failed run's to.
    const b = await idOf(t.saved({ apple: 'on' }));
    expect(await t.runOf(b)).toMatchObject({ from_channels: '{"apple":"off"}' });
    await failRun(ctx, a, 'CHANNEL_APPLY_FAILED');
    // Not a no-op revert: the passes the failed run retired come back.
    expect(await t.work(b).done).toEqual({ state: 'done' });
    expect(await t.retired('apple')).toHaveLength(0);
  });

  it.each([3, 4])(
    'a retried step %i of a run that fails changes nothing twice',
    async (retryAt) => {
      const t = await applyKit(1);
      const id = await idOf(t.saved({ apple: 'off' }));
      await t.exec("UPDATE orgs SET status = 'suspended' WHERE id = ?", t.orgId);
      expect(await t.work(id, { retryAt }).done).toEqual({ state: 'failed' });
      expect(await t.runOf(id)).toMatchObject({
        state: 'failed',
        error_code: 'CHANNEL_APPLY_ORG_INACTIVE',
      });
    },
  );
});
