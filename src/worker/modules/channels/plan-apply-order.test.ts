// MT4a review M2 and L7: plan-change jobs are keyed on the entitlement revision, so order and retries do
// not lose or repeat a journal entry.
import { describe, expect, it } from 'vitest';
import { handleEntitlementApply, onEntitlementsChanged } from './entitlement-apply.ts';
import { type Job, legacy, planKit, trial } from './plan-apply-test-fixtures.ts';
import { writeDrop } from './repo-apply-write.ts';
import { getRun } from './repo-runs.ts';

const paperOff = { ...legacy, print: 0 as const };

/** Two platform writes, legacy -> paper off (revision 2) -> trial (revision 3), the plan left at trial. */
async function twoChanges() {
  const k = await planKit();
  await k.setPlan('trial');
  await onEntitlementsChanged(k.ctx, k.t.orgId, legacy, paperOff, 'platform:test', 2);
  await onEntitlementsChanged(k.ctx, k.t.orgId, paperOff, trial, 'platform:test', 3);
  const [a, b] = k.jobs() as [Job, Job];
  return { ...k, a, b };
}

describe('plan-change jobs out of order and repeated', () => {
  it('a later job first, then the earlier one: one run covers both, from the plan before the first', async () => {
    const { t, ctx, a, b, planRuns, flips } = await twoChanges();
    expect(a.revision).toBe(2);
    expect(b.revision).toBe(3);
    await handleEntitlementApply(b, ctx);
    expect(await planRuns()).toHaveLength(1);
    await handleEntitlementApply(a, ctx);
    const runs = await planRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      state: 'pending',
      from_rev: 2,
      to_rev: 3,
      from_blocked: '[]',
      to_blocked: '["samsung","paper","nfc"]',
    });
    await t.work(runs[0]?.id as string).done;
    // Paper and nfc flipped on both passes, once.
    expect(await flips()).toBe(4);
  });

  it('the same two jobs in order give the same run', async () => {
    const { t, ctx, a, b, planRuns, flips } = await twoChanges();
    await handleEntitlementApply(a, ctx);
    await handleEntitlementApply(b, ctx);
    const runs = await planRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ from_rev: 2, to_rev: 3, from_blocked: '[]' });
    await t.work(runs[0]?.id as string).done;
    expect(await flips()).toBe(4);
  });

  it('a retry after the run ran opens no second run and journals nothing twice', async () => {
    const { t, ctx, a, b, planRuns, flips } = await twoChanges();
    await handleEntitlementApply(a, ctx);
    await handleEntitlementApply(b, ctx);
    await t.work(((await planRuns())[0] as { id: string }).id).done;
    const done = await flips();
    expect(done).toBe(4);
    for (const job of [a, b, a]) await handleEntitlementApply(job, ctx);
    expect(await planRuns()).toHaveLength(1);
    expect(await flips()).toBe(done);
    expect(t.created).toHaveLength(1);
  });

  it('a retry after a run joined a pending template save and started does not open another', async () => {
    const { t, ctx, a, b, planRuns, flips } = await twoChanges();
    const save = (await t.saved({ apple: 'off' })) as { workflowInstanceId: string };
    await handleEntitlementApply(a, ctx);
    await handleEntitlementApply(b, ctx);
    expect((await planRuns()).map((r) => r.id)).toEqual([save.workflowInstanceId]);
    await t.work(save.workflowInstanceId).done;
    const done = await flips();
    await handleEntitlementApply(a, ctx);
    await handleEntitlementApply(b, ctx);
    expect(await planRuns()).toHaveLength(1);
    expect(await flips()).toBe(done);
  });

  it('a job whose neighbour has not arrived is retried, and records nothing', async () => {
    const { t, ctx, a, planRuns } = await twoChanges();
    await handleEntitlementApply(a, ctx);
    const gap: Job = { ...a, revision: 9, blockedBefore: ['paper', 'nfc'], blockedAfter: [] };
    await expect(handleEntitlementApply(gap, ctx)).rejects.toMatchObject({
      code: 'CHANNEL_ENTITLEMENT_RETRY',
    });
    const [run] = await planRuns();
    expect(run).toMatchObject({ from_rev: 2, to_rev: 2, to_blocked: '["paper"]' });
    expect(t.created).toHaveLength(1);
  });

  it('a drop pinned to an older read of the run does nothing once a job extended it', async () => {
    const { t, ctx, a, b, planRuns } = await twoChanges();
    await handleEntitlementApply(a, ctx);
    const [pending] = await planRuns();
    const read = await getRun(t.db, pending?.id as string);
    t.kit.clock.advance(1000);
    await handleEntitlementApply(b, ctx);
    expect(await writeDrop(ctx, read as NonNullable<typeof read>)).toBe(false);
    expect((await planRuns())[0]).toMatchObject({ state: 'pending', to_rev: 3 });
  });

  it('freezes the plan state of a run once it started', async () => {
    const { t, ctx, a, b, planRuns } = await twoChanges();
    await handleEntitlementApply(a, ctx);
    await handleEntitlementApply(b, ctx);
    const id = ((await planRuns())[0] as { id: string }).id;
    await t.work(id).done;
    await expect(
      t.exec('UPDATE channel_apply_runs SET from_blocked = \'["paper"]\' WHERE id = ?', id),
    ).rejects.toThrow(/frozen/);
  });
});
