import { describe, expect, it } from 'vitest';
import { handleEntitlementApply } from './entitlement-apply.ts';
import { type Job, legacy, planKit, trial } from './plan-apply-test-fixtures.ts';

describe('a feature transition starts channel-apply runs', () => {
  it('queues nothing when the plan change moves no channel', async () => {
    const { change, jobs } = await planKit();
    await change(legacy, { ...legacy, webhooks: 0, nfc: 'basic' }, 'legacy');
    expect(jobs()).toHaveLength(0);
  });

  it('opens one pending run per template and mode with the plan as it was, and starts its instance', async () => {
    const { t, ctx, change, planRuns } = await planKit();
    const job = await change(legacy, trial, 'trial');
    expect(job).toMatchObject({ orgId: t.orgId, blockedBefore: [], requestedBy: 'platform:test' });
    await handleEntitlementApply(job as Job, ctx);
    const [run] = await planRuns();
    expect(run).toMatchObject({ state: 'pending', from_blocked: '[]', replace_channels: '[]' });
    expect(t.created).toEqual([{ id: run?.id, params: { runId: run?.id } }]);
  });

  it('a retried job opens no second run', async () => {
    const { t, ctx, change, planRuns } = await planKit();
    const job = (await change(legacy, trial, 'trial')) as Job;
    await handleEntitlementApply(job, ctx);
    const [run] = await planRuns();
    await t.work(run?.id as string).done;
    await handleEntitlementApply(job, ctx);
    expect(await planRuns()).toHaveLength(1);
  });

  it('a downgrade pauses: it journals the flips and keeps passes, copies and prints', async () => {
    const { t, ctx, change, effective, flips, planRuns } = await planKit();
    const before = await effective(t.ids[0] as string);
    expect(before.paper?.on).toBe(true);
    expect(before.nfc?.on).toBe(true);
    const job = (await change(legacy, trial, 'trial')) as Job;
    await handleEntitlementApply(job, ctx);
    const [run] = await planRuns();
    expect(await t.work(run?.id as string).done).toEqual({ state: 'done' });
    for (const id of t.ids) {
      const e = await effective(id);
      expect(e.paper).toEqual({ on: false, source: 'platform', reason: 'not_included' });
      expect(e.nfc).toEqual({ on: false, source: 'platform', reason: 'not_included' });
      expect(e.apple).toEqual({ on: true, source: 'template' });
    }
    // Paper and nfc flipped on both passes; google was never on (not released).
    expect(await flips()).toBe(4);
    expect(await t.runOf(run?.id as string)).toMatchObject({
      state: 'done',
      counts: expect.stringContaining('"flips":4'),
    });
    // Nothing retired, voided or deleted: a kill switch converges the view only.
    const ids = t.ids.map(() => '?').join(',');
    expect(
      await t.count(
        `SELECT COUNT(*) AS n FROM pass_channels WHERE retired_at IS NOT NULL AND pass_id IN (${ids})`,
        ...t.ids,
      ),
    ).toBe(0);
    expect(
      await t.count(
        `SELECT COUNT(*) AS n FROM passes WHERE deleted_at IS NULL AND status = 'active' AND id IN (${ids})`,
        ...t.ids,
      ),
    ).toBe(2);
    expect(t.bumpsQueued()).toBe(0);
    const detail = await t.db
      .prepare(
        "SELECT detail FROM audit_log WHERE action = 'pass.channels_change' AND target_id = ? ORDER BY at DESC LIMIT 1",
      )
      .bind(t.ids[0])
      .first<{ detail: string }>();
    expect(JSON.parse(detail?.detail ?? '{}')).toMatchObject({
      from: 'on',
      to: 'off',
      source: 'platform',
    });
  });

  it('an upgrade restores: the channels read on again and the run journals the way back', async () => {
    const { t, ctx, change, effective, flips, planRuns } = await planKit();
    await handleEntitlementApply((await change(legacy, trial, 'trial')) as Job, ctx);
    await t.work(((await planRuns())[0] as { id: string }).id).done;
    t.kit.clock.advance(60_000);

    const up = (await change(trial, legacy, 'legacy')) as Job;
    expect(up.blockedBefore).toEqual(['samsung', 'paper', 'nfc']);
    await handleEntitlementApply(up, ctx);
    const runs = (await t.runs()).filter((r) => r.state === 'pending');
    expect(runs).toHaveLength(1);
    expect(await t.work(runs[0]?.id as string).done).toEqual({ state: 'done' });
    for (const id of t.ids) {
      const e = await effective(id);
      expect(e.paper).toEqual({ on: true, source: 'template' });
      expect(e.nfc).toEqual({ on: true, source: 'template' });
    }
    expect(await flips()).toBe(8);
  });

  it('a downgrade undone before the run starts drops the run', async () => {
    const { t, ctx, change, flips, planRuns } = await planKit();
    await handleEntitlementApply((await change(legacy, trial, 'trial')) as Job, ctx);
    const [run] = await planRuns();
    await change(trial, legacy, 'legacy');
    await handleEntitlementApply(jobs(t).at(-1) as Job, ctx);
    expect(await t.work(run?.id as string).done).toEqual({ state: 'dropped' });
    expect(await flips()).toBe(0);
    expect((await t.runs()).filter((r) => r.state === 'pending')).toHaveLength(0);
  });

  it('joins the pending run of a template save: the plan state rides it', async () => {
    const { t, ctx, change } = await planKit();
    const saved = (await t.saved({ apple: 'off' })) as { workflowInstanceId: string };
    await handleEntitlementApply((await change(legacy, trial, 'trial')) as Job, ctx);
    const runs = (await t.runs()).filter((r) => r.state === 'pending');
    expect(runs.map((r) => r.id)).toEqual([saved.workflowInstanceId]);
    expect(runs[0]?.from_blocked).toBe('[]');
    // Only the save's own instance exists: the plan change joined its run.
    expect(t.created).toHaveLength(1);
    expect(await t.work(saved.workflowInstanceId).done).toEqual({ state: 'done' });
    // Apple retires by the template's own choice; the plan only flips paper and nfc, without a retirement.
    expect(await t.retired('apple')).toHaveLength(2);
    expect(await t.retired('nfc')).toHaveLength(0);
    expect(await t.retired('paper')).toHaveLength(0);
  });
});

const jobs = (t: Awaited<ReturnType<typeof planKit>>['t']) =>
  (t.kit.queue.sent as { kind: string }[]).filter((m) => m.kind === 'channel.entitlement');
