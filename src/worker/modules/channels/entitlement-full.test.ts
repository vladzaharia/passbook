import { describe, expect, it } from 'vitest';
import type { JobOf } from '../../jobs/types.ts';
import { first } from '../../platform/db.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { applyKit } from './apply-test-fixtures.ts';
import { handleEntitlementApply, onEntitlementsChanged } from './entitlement-apply.ts';

describe('a full reconcile brings every pass to the plan in both directions', () => {
  it('resumes what the plan allows, stops nothing it only blocks, and a second run changes nothing', async () => {
    const t = await applyKit(2);
    // Apple is retired by the template's own choice; the policy then moves back with no run (the gap).
    const off = (await t.saved({ apple: 'off' })) as { workflowInstanceId: string };
    await t.work(off.workflowInstanceId).done;
    expect(await t.retired('apple')).toHaveLength(2);
    await t.exec(
      'DELETE FROM template_channel_policies WHERE org_id = ? AND template_id = ?',
      t.orgId,
      t.templateId,
    );
    // The plan blocks paper and nfc now (an override written with no journal): they are only flips, never retirements.
    await t.exec(
      "INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'print', '0', ?)",
      t.orgId,
      t.kit.clock.now(),
    );
    const ctx = () => jobCtxOf(t.kit);
    const jobs = () =>
      (t.kit.queue.sent as { kind: string }[]).filter(
        (m) => m.kind === 'channel.entitlement',
      ) as JobOf<'channel.entitlement'>[];
    const reconcile = async () => {
      await t.exec('UPDATE org_entitlements SET revision = revision + 1 WHERE org_id = ?', t.orgId);
      const revision =
        (
          await first<{ revision: number }>(
            t.db,
            'SELECT revision FROM org_entitlements WHERE org_id = ?',
            [t.orgId],
          )
        )?.revision ?? 0;
      const sent = jobs().length;
      const after = await entitlementsOf(ctx(), t.orgId);
      await onEntitlementsChanged(ctx(), t.orgId, {}, after, 'system', revision, true);
      expect(jobs()).toHaveLength(sent + 1);
      const job = jobs().at(-1) as JobOf<'channel.entitlement'>;
      expect(job).toMatchObject({ full: true, blockedBefore: [] });
      expect(job.blockedAfter).toContain('paper');
      await handleEntitlementApply(job, ctx());
      const open = (await t.runs()).find((r) => r.state === 'pending');
      expect(open).toMatchObject({ reconcile_all: 1 });
      expect(await t.work(String(open?.id)).done).toEqual({ state: 'done' });
    };
    const state = async () =>
      JSON.stringify([
        await t.retired('apple'),
        await t.retired('paper'),
        await t.retired('nfc'),
        await t.feed(),
        await t.audits('pass.channels_change'),
      ]);

    await reconcile();
    // Blocked -> allowed: the retired copies work again. Allowed -> blocked: paper and nfc retire nothing.
    expect(await t.retired('apple')).toEqual([]);
    expect(await t.retired('paper')).toEqual([]);
    expect(await t.retired('nfc')).toEqual([]);
    const settled = await state();
    await reconcile();
    expect(await state()).toBe(settled);
  });
});
