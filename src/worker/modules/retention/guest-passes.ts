import { guestUntil } from '../../../passkit/template/access/decide.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { AccessManifest, Json, TemplateManifest } from '../../../passkit/types.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { deletePass } from '../passes/service.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { healHead } from './head-store.ts';
import {
  type PreparedReceipt,
  prepareReceipt,
  type ReceiptInput,
  recordHead,
  writeReceipt,
} from './receipt-service.ts';
import {
  type GuestCandidate,
  guestCandidates,
  passHeld,
  receiptExists,
} from './repo-guest-passes.ts';
import { chainHead } from './repo-receipts.ts';
import type { Scope } from './repo-sweep.ts';
import { retentionTargets } from './targets.ts';

const DAY = 86_400_000;
const BATCH = 50;
/** Passes one run removes: the platform pass, then all org passes together. A backlog drains over days. */
export const GUEST_LIMITS = { platform: 200, orgs: 200 };
/** Candidates one run reads, so passes that keep being skipped cannot starve the job. */
const READ_LIMIT = 2000;

/** The pass's end: its own, else the plan's days from the start day. */
function endOf(c: GuestCandidate, timeZone: string): number | null {
  const access = JSON.parse(c.access) as AccessManifest;
  const inputs = applyDefaults(
    { inputs: c.inputs ? JSON.parse(c.inputs) : {} } as TemplateManifest,
    JSON.parse(c.personalization) as Record<string, Json>,
  );
  const plan = access.plans.find((p) => p.id === inputs[access.input.plan]);
  if (plan?.kind !== 'guest') return null;
  return guestUntil(access, plan, inputs, c.created_at, timeZone);
}

/**
 * Soft-deletes the pass as the system with its receipt in the same batch: the receipt lands only while this
 * delete did, so a crash cannot lose it. A hold that landed after the page was read refuses the delete itself.
 */
async function removePass(
  ctx: ServiceContext,
  c: GuestCandidate,
  receipt: Omit<ReceiptInput, 'deleted'>,
): Promise<boolean> {
  const prepared: PreparedReceipt[] = [];
  try {
    await deletePass(ctx, { type: 'system', id: null }, c.id, c.org_id, undefined, {
      unlessHeld: true,
      inBatch: async (at) => {
        const r = await prepareReceipt(ctx, { ...receipt, deleted: 1 }, deletedGate(c.id, at));
        prepared.push(r);
        return [r.stmt];
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    if (error instanceof ConflictError && (await passHeld(ctx.env.DB, c.org_id, c.id)))
      return false;
    throw error;
  }
  const done = prepared[0];
  // A racing receipt on the same chain refuses the in-batch insert; the delete stands, so append it now.
  if (done && (await receiptExists(ctx.env.DB, done.receipt.id)))
    await recordHead(ctx, done.receipt);
  else await writeReceipt(ctx, { ...receipt, deleted: 1 });
  return true;
}

/**
 * Daily: a pass whose current access plan is a guest plan is deleted once its end is more days past than the
 * `visitors` retention plan allows (the org's days, floors and holds, else the platform's). It goes through
 * `deletePass` (void, push, soft delete; scans keep their counts and lose the pass link). A held pass or org,
 * a pending credential transfer, a plan that is no longer guest and an extended end all keep it.
 */
export async function dailyGuestPasses(ctx: ServiceContext): Promise<void> {
  const targets = await retentionTargets(ctx, ['visitors']);
  if (!targets) return;
  const now = ctx.clock.now();
  const reads = { left: READ_LIMIT };
  let removed = 0;
  const zones = new Map<string, string>();
  const zoneOf = async (orgId: string) => {
    const known = zones.get(orgId);
    if (known) return known;
    const zone = (await readOrgTimeZone(ctx.env.DB, orgId)) ?? 'UTC';
    zones.set(orgId, zone);
    return zone;
  };
  const run = async (
    orgId: string | null,
    days: number,
    scope: Scope,
    budget: { left: number },
  ) => {
    await healHead(ctx, orgId, 'visitors', await chainHead(ctx.env.DB, orgId, 'visitors'));
    const cutoff = now - days * DAY;
    let after = '';
    while (budget.left > 0 && reads.left > 0) {
      const limit = Math.min(BATCH, reads.left);
      // The pass is created before its end, so a pass created after the cutoff by `created_at` is skipped here.
      const page = await guestCandidates(ctx.env.DB, cutoff, after, limit, scope);
      reads.left -= page.length;
      for (const c of page) {
        if (budget.left <= 0) break;
        try {
          const end = endOf(c, await zoneOf(c.org_id));
          if (end === null || end >= cutoff) continue;
          const gone = await removePass(ctx, c, {
            orgId,
            cls: 'visitors',
            kind: 'visitor',
            policyDays: days,
            cutoffAt: cutoff,
          });
          if (!gone) continue;
          budget.left--;
          removed++;
        } catch (error) {
          ctx.log.error('retention.guest_pass_failed', {
            orgId: c.org_id,
            code: 'GUEST_PASS_RETENTION',
            error,
          });
        }
      }
      const last = page[page.length - 1];
      if (page.length < limit || !last) break;
      after = last.id;
    }
  };
  await run(
    null,
    targets.platform.visitors,
    { kind: 'platform', exclude: targets.exclude },
    { left: GUEST_LIMITS.platform },
  );
  const budget = { left: GUEST_LIMITS.orgs };
  let visited = 0;
  for (const o of targets.orgs) {
    if (budget.left <= 0 || reads.left <= 0) break;
    try {
      await run(o.orgId, o.days.visitors, { kind: 'org', orgId: o.orgId }, budget);
    } catch (error) {
      ctx.log.error('retention.guest_passes_org_failed', {
        orgId: o.orgId,
        code: 'GUEST_PASS_RETENTION',
        error,
      });
    }
    visited++;
  }
  await targets.finish(visited);
  if (removed > 0) ctx.log.info('retention.guest_passes', { removed });
}
