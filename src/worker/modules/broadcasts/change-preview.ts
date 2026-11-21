import type { z } from 'zod';
import {
  type ChangePreviewBodySchema,
  type ChangeRunPreviewSchema,
  changeOpsOf,
} from '../../../shared/contracts/broadcasts-change.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { fieldChanges } from '../../../shared/issuing/diff.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { BUDGET_WINDOW_MS } from '../passes/change-messages.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { targetFilter } from './apply.ts';
import { resolveOps } from './change-ops.ts';
import { prepareTarget, storedTargetOf } from './change-target.ts';
import { countTarget, targetRows } from './repo-target.ts';

type Body = z.infer<typeof ChangePreviewBodySchema>;
type ChangePreview = z.infer<typeof ChangeRunPreviewSchema>;

/** Passes read for the samples and the counts that follow them; a larger target is scaled from these. */
const SAMPLED = 200;
const SAMPLES = 20;

/**
 * The live count behind the composer: matches, on-device and already at the daily limit. With a
 * patch, also what it would do: sample before/after diffs, passes already at the new values, passes
 * it cannot change (by reason) and how many holders it would notify. Counts for a target over
 * 200 passes come from its newest 200, scaled, and say so (`estimated`).
 */
export async function previewChange(
  ctx: ServiceContext,
  mode: Mode,
  body: Body,
): Promise<ChangePreview> {
  const limit = (await getPlatformSettings(ctx))['push.budgetPerDay'];
  const now = ctx.clock.now();
  // The count the admin saw is not a precondition of looking: drift is judged when the run starts.
  const { expectCount: _seen, ...target } = body.target;
  const prepared = await prepareTarget(ctx, mode, {
    orgId: body.orgId,
    kind: 'change',
    target,
    patch: body.patch ?? {},
    notify: body.notify ?? true,
    send: 'draft',
  });
  const filter = targetFilter(
    { org_id: body.orgId, mode, target: JSON.stringify(storedTargetOf(prepared)) },
    null,
    1,
  );
  const counts = await countTarget(ctx.env.DB, filter, now, now - BUDGET_WINDOW_MS, limit);
  const out: ChangePreview = {
    ...counts,
    limit,
    samples: [],
    unchanged: 0,
    blocked: [],
    notified: 0,
    silent: 0,
  };
  if (!body.patch || counts.targeted === 0) return out;
  const { ops } = changeOpsOf(body.patch);
  const rows = await targetRows(ctx.env.DB, filter, now, SAMPLED);
  const schemas = new Map<string, unknown>();
  const blocked = new Map<string, number>();
  let unchanged = 0;
  let changing = 0;
  for (const pass of rows) {
    const key = `${pass.templateId}@${pass.templateVersion}`;
    if (!schemas.has(key))
      schemas.set(
        key,
        (await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion)).manifest
          .inputs,
      );
    const result = resolveOps(ops, pass.personalization);
    if (!result.ok) blocked.set(result.code, (blocked.get(result.code) ?? 0) + 1);
    else if (JSON.stringify(result.from) === JSON.stringify(result.to)) unchanged++;
    else {
      changing++;
      if (out.samples.length < SAMPLES)
        out.samples.push({
          passId: pass.id,
          title: pass.displayTitle,
          changes: fieldChanges(schemas.get(key), pass.personalization, result.next),
        });
    }
  }
  const scale = counts.targeted > rows.length ? counts.targeted / rows.length : 1;
  const scaled = (n: number) => Math.round(n * scale);
  const willChange = scaled(changing);
  const silent =
    (body.notify ?? true)
      ? Math.min(willChange, Math.round((willChange * counts.overBudget) / counts.targeted))
      : willChange;
  return {
    ...out,
    unchanged: scaled(unchanged),
    blocked: [...blocked].map(([code, n]) => ({ code, count: scaled(n) })),
    notified: willChange - silent,
    silent,
    ...(scale > 1 ? { estimated: true } : {}),
  };
}
