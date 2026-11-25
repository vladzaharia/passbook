import type { z } from 'zod';
import {
  type ChangePreviewBodySchema,
  type ChangeRunPreviewSchema,
  changeActionOf,
  changeOpsOf,
} from '../../../shared/contracts/broadcasts-change.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { fieldChanges } from '../../../shared/issuing/diff.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { BUDGET_WINDOW_MS } from '../passes/change-messages.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { activeRelease } from '../templates/releases.ts';
import { targetFilter } from './apply.ts';
import { resolveOps } from './change-ops.ts';
import { prepareTarget, storedTargetOf } from './change-target.ts';
import { checkTargetReleases } from './guards.ts';
import { countTarget, sampleBudgetState, targetRows } from './repo-target.ts';

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
  await checkTargetReleases(ctx, prepared, mode);
  const filter = {
    ...targetFilter(
      { org_id: body.orgId, mode, target: JSON.stringify(storedTargetOf(prepared)) },
      null,
      1,
    ),
    ...(prepared.target.passIds ? { passIds: prepared.target.passIds } : {}),
  };
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
  const action = changeActionOf(body.patch);
  const designs = new Map<string, string | null>();
  const rows = await targetRows(ctx.env.DB, filter, now, SAMPLED);
  const schemas = new Map<string, unknown>();
  const timeZone = await readOrgTimeZone(ctx.env.DB, body.orgId);
  const blocked = new Map<string, number>();
  let unchanged = 0;
  let changing = 0;
  const changingIds: string[] = [];
  for (const pass of rows) {
    if (action) {
      let latest: string | null = null;
      if (action === 'design') {
        if (!designs.has(pass.templateId))
          designs.set(
            pass.templateId,
            (await activeRelease(ctx, pass.templateId, pass.orgId, pass.mode, 'apple'))?.version ??
              null,
          );
        latest = designs.get(pass.templateId) ?? null;
        // A template without a release was refused before sampling (checkTargetReleases).
        if (latest === pass.templateVersion) unchanged++;
      }
      if (action === 'void' || (latest && latest !== pass.templateVersion)) {
        changing++;
        changingIds.push(pass.id);
        if (out.samples.length < SAMPLES)
          out.samples.push({
            passId: pass.id,
            title: pass.displayTitle,
            changes:
              action === 'void'
                ? [{ key: 'status', label: 'Status', from: 'Active', to: 'Voided' }]
                : [{ key: 'design', label: 'Design', from: pass.templateVersion, to: latest }],
          });
      }
      continue;
    }
    const key = `${pass.templateId}@${pass.templateVersion}`;
    if (!schemas.has(key))
      schemas.set(
        key,
        (await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion)).manifest
          .inputs,
      );
    const result = resolveOps(ops, pass.personalization, timeZone);
    if (!result.ok) blocked.set(result.code, (blocked.get(result.code) ?? 0) + 1);
    else if (JSON.stringify(result.from) === JSON.stringify(result.to)) unchanged++;
    else {
      changing++;
      changingIds.push(pass.id);
      if (out.samples.length < SAMPLES)
        out.samples.push({
          passId: pass.id,
          title: pass.displayTitle,
          changes: fieldChanges(schemas.get(key), pass.personalization, result.next, { timeZone }),
        });
    }
  }
  const scale = counts.targeted > rows.length ? counts.targeted / rows.length : 1;
  const scaled = (n: number) => Math.round(n * scale);
  const willChange = scaled(changing);
  // Holders are told when the run asks, the pass is on a device and not at its daily limit, each read
  // from the sampled passes themselves. Whether a field the pass shows changes is only known on build.
  const asks = action !== 'void' && body.notify === true;
  const state = asks
    ? await sampleBudgetState(
        ctx.env.DB,
        changingIds,
        body.orgId,
        mode,
        now - BUDGET_WINDOW_MS,
        limit,
      )
    : null;
  const told = state
    ? changingIds.filter((id) => state.onDevice.has(id) && !state.over.has(id))
    : [];
  const silent = willChange - scaled(told.length);
  return {
    ...out,
    unchanged: scaled(unchanged),
    blocked: [...blocked].map(([code, n]) => ({ code, count: scaled(n) })),
    notified: scaled(told.length),
    silent,
    // Counts of a larger target come from its newest 200 passes; who is told is always an estimate.
    estimated: true,
  };
}
