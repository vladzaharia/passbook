import { guestUntil } from '../../../passkit/template/access/decide.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { AccessManifest, Json, TemplateManifest } from '../../../passkit/types.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { deletePass } from '../passes/service.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { readCursors, writeCursors } from './guest-state.ts';
import { healHead } from './head-store.ts';
import {
  type PreparedReceipt,
  prepareReceipt,
  recordHead,
  writeReceipt,
} from './receipt-service.ts';
import {
  deletedGate,
  type GuestCandidate,
  guestCandidates,
  guestTemplates,
  receiptExists,
} from './repo-guest-passes.ts';
import { chainHead } from './repo-receipts.ts';
import type { Scope } from './repo-sweep.ts';
import { retentionTargets } from './targets.ts';

const DAY = 86_400_000;
const BATCH = 50;
/** Candidates one scope reads per run: the platform pass and each org have their own, so one cannot use it all. */
const READ_LIMIT = 500;
/**
 * A delete costs 15 to 25 D1 queries and every daily hook shares one invocation (1,000 queries; the runner
 * stops starting hooks at 900). This hook may spend `QUERY_ALLOWANCE` queries, and never past `QUERY_CEILING`,
 * so the hooks after it still run. Without a counter (a direct call) it deletes at most `DELETE_CAP`.
 */
const QUERY_ALLOWANCE = 300;
const QUERY_CEILING = 700;
const DELETE_CAP = 20;
/** No zone set: the owner's default, never UTC. */
const REASON = 'retention.guest_passes';

/** The pass's end under one manifest: its own, else the plan's days from the start day; null when not a guest plan. */
function endUnder(
  c: GuestCandidate,
  access: string,
  inputsJson: string | null,
  timeZone: string,
): number | null {
  const manifest = JSON.parse(access) as AccessManifest;
  const inputs = applyDefaults(
    { inputs: inputsJson ? JSON.parse(inputsJson) : {} } as TemplateManifest,
    JSON.parse(c.personalization) as Record<string, Json>,
  );
  const plan = manifest.plans.find((p) => p.id === inputs[manifest.input.plan]);
  if (plan?.kind !== 'guest') return null;
  return guestUntil(manifest, plan, inputs, c.created_at, timeZone);
}

/** The later end under the pinned version and under the release the door reads: both must say guest. */
function endOf(c: GuestCandidate, timeZone: string): number | null {
  const pinned = endUnder(c, c.access, c.inputs, timeZone);
  const active = endUnder(c, c.active_access, c.active_inputs, timeZone);
  return pinned === null || active === null ? null : Math.max(pinned, active);
}

/**
 * Soft-deletes the pass as the system with its receipt in the same batch: the receipt lands only while this
 * delete did, so a crash cannot lose it. A hold, a pending transfer or a change since the page was read keeps it.
 */
async function removePass(
  ctx: ServiceContext,
  c: GuestCandidate,
  receipt: { orgId: string | null; policyDays: number; cutoffAt: number },
): Promise<boolean> {
  const prepared: PreparedReceipt[] = [];
  try {
    await deletePass(ctx, { type: 'system', id: null }, c.id, c.org_id, undefined, {
      unlessHeld: true,
      expectRowVersion: c.row_version,
      reason: REASON,
      inBatch: async (at) => {
        const r = await prepareReceipt(
          ctx,
          { ...receipt, cls: 'visitors', kind: 'visitor', deleted: 1 },
          deletedGate(c.id, at),
        );
        prepared.push(r);
        return [r.stmt];
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    if (error instanceof ConflictError && error.code === 'PASS_CONFLICT') return false;
    throw error;
  }
  const done = prepared[0];
  // A racing receipt on the same chain refuses the in-batch insert; the delete stands, so append it now.
  if (done && (await receiptExists(ctx.env.DB, done.receipt.id)))
    await recordHead(ctx, done.receipt);
  else await writeReceipt(ctx, { ...receipt, cls: 'visitors', kind: 'visitor', deleted: 1 });
  return true;
}

/**
 * Daily: a live pass whose access plan is a guest plan, under the pinned version and the release the door reads,
 * is deleted once its end is more days past than the `visitors` retention plan allows (the org's days, floors and
 * holds, else the platform's). It goes through `deletePass` (void, push, soft delete; scans keep their counts and
 * lose the pass link). A held pass or org, a pending credential transfer, a plan that is no longer guest and an
 * extended end all keep it.
 */
export async function dailyGuestPasses(ctx: ServiceContext): Promise<void> {
  const targets = await retentionTargets(ctx, ['visitors']);
  if (!targets) return;
  const now = ctx.clock.now();
  const cursors = await readCursors(ctx);
  const startQueries = ctx.queries?.() ?? 0;
  let removed = 0;
  const spent = () =>
    ctx.queries
      ? ctx.queries() >= Math.min(startQueries + QUERY_ALLOWANCE, QUERY_CEILING)
      : removed >= DELETE_CAP;
  const zones = new Map<string, string>();
  const zoneOf = async (orgId: string) => {
    const known = zones.get(orgId);
    if (known) return known;
    const zone = (await readOrgTimeZone(ctx.env.DB, orgId)) ?? DEFAULT_TIME_ZONE;
    zones.set(orgId, zone);
    return zone;
  };
  const templates = await guestTemplates(ctx.env.DB);
  const run = async (orgId: string | null, days: number, scope: Scope) => {
    await healHead(ctx, orgId, 'visitors', await chainHead(ctx.env.DB, orgId, 'visitors'));
    const cutoff = now - days * DAY;
    const key = orgId ?? '';
    const [from = '', resume = ''] = cursors[key] ?? [];
    let reads = READ_LIMIT;
    let at: [string, string] | null = null;
    for (const templateId of templates) {
      if (templateId < from) continue;
      let after = templateId === from ? resume : '';
      for (;;) {
        if (reads <= 0 || spent()) {
          at ??= [templateId, after];
          break;
        }
        const limit = Math.min(BATCH, reads);
        // The pass is created before its end, so a pass created after the cutoff by `created_at` is skipped here.
        const page = await guestCandidates(ctx.env.DB, templateId, cutoff, after, limit, scope);
        reads -= page.length;
        let stopped = false;
        for (const c of page) {
          if (spent()) {
            stopped = true;
            break;
          }
          after = c.id;
          try {
            const end = endOf(c, await zoneOf(c.org_id));
            if (end === null || end >= cutoff) continue;
            if (await removePass(ctx, c, { orgId, policyDays: days, cutoffAt: cutoff })) removed++;
          } catch (error) {
            ctx.log.error('retention.guest_pass_failed', {
              orgId: c.org_id,
              code: 'GUEST_PASS_RETENTION',
              error,
            });
          }
        }
        if (stopped) {
          at ??= [templateId, after];
          break;
        }
        if (page.length < limit) break;
      }
      if (at) break;
    }
    // A scan that read to the end starts over next run; one that stopped early resumes where it was.
    if (at) cursors[key] = at;
    else delete cursors[key];
  };
  const guarded = async (orgId: string | null, days: number, scope: Scope) => {
    try {
      await run(orgId, days, scope);
    } catch (error) {
      ctx.log.error('retention.guest_passes_scope_failed', {
        orgId,
        code: 'GUEST_PASS_RETENTION',
        error,
      });
    }
  };
  await guarded(null, targets.platform.visitors, { kind: 'platform', exclude: targets.exclude });
  let visited = 0;
  for (const o of targets.orgs) {
    if (spent()) break;
    await guarded(o.orgId, o.days.visitors, { kind: 'org', orgId: o.orgId });
    visited++;
  }
  await targets.finish(visited);
  const live = new Set(targets.orgs.map((o) => o.orgId));
  for (const key of Object.keys(cursors)) if (key !== '' && !live.has(key)) delete cursors[key];
  await writeCursors(ctx, cursors);
  if (removed > 0) ctx.log.info('retention.guest_passes', { removed });
}
