import { guestUntil } from '../../../passkit/template/access/decide.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { AccessManifest, Json, TemplateManifest } from '../../../passkit/types.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { deletePass } from '../passes/service.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { healHead } from './head-store.ts';
import { writeReceipt } from './receipt-service.ts';
import { type GuestCandidate, guestCandidates, passHeld } from './repo-guest-passes.ts';
import { chainHead } from './repo-receipts.ts';
import type { Scope } from './repo-sweep.ts';
import { retentionTargets } from './targets.ts';

const DAY = 86_400_000;
const BATCH = 50;
/** Passes one run removes: the platform pass, then all org passes together. A backlog drains over days. */
export const GUEST_LIMITS = { platform: 200, orgs: 200 };
/** Candidates one run reads, so passes that keep being skipped cannot starve the job. */
const READ_LIMIT = 2000;

/** The pass's end: its own, else the plan's days from the start day; the later of any old visit row's. */
function endOf(c: GuestCandidate, timeZone: string): number | null {
  const access = JSON.parse(c.access) as AccessManifest;
  const inputs = applyDefaults(
    { inputs: c.inputs ? JSON.parse(c.inputs) : {} } as TemplateManifest,
    JSON.parse(c.personalization) as Record<string, Json>,
  );
  const plan = access.plans.find((p) => p.id === inputs[access.input.plan]);
  if (plan?.kind !== 'guest') return null;
  const end = guestUntil(access, plan, inputs, c.created_at, timeZone);
  return Math.max(end, c.visit_until ?? 0);
}

/** Soft-deletes the pass as the system; a hold that landed after the page was read refuses it in the write. */
async function removePass(ctx: ServiceContext, c: GuestCandidate): Promise<boolean> {
  try {
    await deletePass(ctx, { type: 'system', id: null }, c.id, c.org_id, undefined, {
      unlessHeld: true,
    });
    return true;
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    if (error instanceof ConflictError && (await passHeld(ctx.env.DB, c.org_id, c.id)))
      return false;
    throw error;
  }
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
          if (!(await removePass(ctx, c))) continue;
          budget.left--;
          await writeReceipt(ctx, {
            orgId,
            cls: 'visitors',
            kind: 'visitor',
            policyDays: days,
            cutoffAt: cutoff,
            deleted: 1,
            anonymised: 0,
          });
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
