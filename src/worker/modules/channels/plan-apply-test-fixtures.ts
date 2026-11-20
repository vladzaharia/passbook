import { presetValues } from '../../../shared/contracts/entitlements.ts';
import type { JobOf } from '../../jobs/types.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { applyKit } from './apply-test-fixtures.ts';
import { onEntitlementsChanged } from './entitlement-apply.ts';

export type Job = JobOf<'channel.entitlement'>;
export const legacy = presetValues('legacy');
export const trial = presetValues('trial');

/** A kit with passes and paper on through a saved, applied template policy: two plan-gated channels are on. */
export async function planKit(passes = 2) {
  const t = await applyKit(passes);
  const saved = (await t.saved({ paper: 'on' })) as { workflowInstanceId: string };
  await t.work(saved.workflowInstanceId).done;
  t.created.length = 0;
  const ctx = jobCtxOf(t.kit);
  const setPlan = (preset: string) =>
    t.exec('UPDATE org_entitlements SET preset = ? WHERE org_id = ?', preset, t.orgId);
  const jobs = () =>
    (t.kit.queue.sent as { kind: string }[]).filter(
      (m) => m.kind === 'channel.entitlement',
    ) as Job[];
  /** One revision per platform write, as MT3's write makes them. */
  let revision = 1;
  /** The platform change: write the plan, then the hook the write calls. */
  const change = async (from: typeof legacy, to: typeof legacy, preset: string) => {
    await setPlan(preset);
    await onEntitlementsChanged(ctx, t.orgId, from, to, 'platform:test', ++revision);
    return jobs().at(-1);
  };
  const effective = async (passId: string) =>
    (
      (await (await t.kit.send('GET', `/passes/${passId}/channels`)).json()) as {
        effective: Record<string, { on: boolean; source: string; reason?: string }>;
      }
    ).effective;
  /** The runs the plan changes opened (a template save's run has no plan state). */
  const planRuns = async () => (await t.runs()).filter((r) => r.from_blocked !== null);
  const audited = () =>
    t.count(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pass.channels_change' AND target_id IN (${t.ids.map(() => '?').join(',')})`,
      ...t.ids,
    );
  /** Flips journaled since the template save above. */
  const baseline = await audited();
  const flips = async () => (await audited()) - baseline;
  return { t, ctx, change, effective, flips, jobs, planRuns, setPlan };
}
