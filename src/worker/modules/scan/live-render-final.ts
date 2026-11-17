import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { takePhotoGrantToken } from './asset-sidecar.ts';
import type { LiveRecipient } from './live-auth.ts';
import { livePhotoUrl, type PreparedLiveRow } from './live-render-plan.ts';
import {
  type LiveRenderFence,
  liveRenderFence,
  liveRenderReceiptStmt,
  liveRenderVisibilityPredicate,
} from './repo-live-render-final.ts';

type Predicate = { sql: string; params: readonly SqlValue[] };
type LiveRenderResultRow = Record<string, unknown>;

/** Identify each part independently so truncated or reordered result arrays cannot authorize a row. */
function current(
  results: readonly D1Result<LiveRenderResultRow>[],
  expected: LiveRenderFence | null,
): boolean {
  if (!expected) return false;
  const matches = results.filter((result) => {
    const row = result?.results?.[0];
    return row?.live_row_index === expected.row && row.live_row_kind === expected.kind;
  });
  if (matches.length !== expected.statements.length) return false;
  const seen = new Set<number>();
  for (const result of matches) {
    const row = result.results?.[0];
    if (
      result.success !== true ||
      result.results?.length !== 1 ||
      row?.current !== 1 ||
      typeof row.live_row_part !== 'number' ||
      !Number.isInteger(row.live_row_part) ||
      row.live_row_part < 0 ||
      row.live_row_part >= expected.statements.length ||
      seen.has(row.live_row_part)
    )
      return false;
    seen.add(row.live_row_part);
  }
  return true;
}

/** Fence every catch-up row, and its photo, in one read-only D1 transaction. */
export async function finishLiveRows(
  ctx: ServiceContext,
  recipient: LiveRecipient,
  plans: readonly (PreparedLiveRow | null)[],
): Promise<ScanLiveRow[]> {
  const db = ctx.env.DB;
  // Every asynchronous proof and grant plan has completed before this common final clock.
  const now = ctx.clock.now();
  const statements: D1PreparedStatement[] = [];
  const groups = plans.map((plan, index) => {
    if (!plan || plan.expiresAt <= now) return null;
    const fresh = plan.freshAt(now);
    if (!fresh) return null;
    const visibleFresh = Number.isFinite(plan.visibleUntil)
      ? [...fresh, liveRenderVisibilityPredicate(now, plan.visibleUntil)]
      : fresh;
    const fence = (pieces: readonly Predicate[] | null, kind: number) =>
      pieces
        ? liveRenderFence(db, pieces, recipient.actor.orgId, recipient.actor.mode, index, kind)
        : null;
    const visible =
      plan.visibleFences && now <= plan.visibleUntil
        ? fence([...plan.visibleFences, ...visibleFresh], 1)
        : null;
    const fallback = fence(plan.fallbackFences && [...plan.fallbackFences, ...fresh], 2);
    const photo =
      plan.visible && visible && plan.grant && plan.grant.plan.expiresAt > now
        ? fence([...plan.grant.photoFences, ...visibleFresh], 3)
        : null;
    for (const part of [visible, fallback, photo]) if (part) statements.push(...part.statements);
    return { plan, visible, fallback, photo };
  });
  if (!statements.length) return [];
  // This receipt makes a missing or damaged trailing result incapable of releasing a photo URL.
  statements.push(liveRenderReceiptStmt(db));
  const results = await db.batch<LiveRenderResultRow>(statements);
  const receipt = results[results.length - 1];
  const complete =
    results.length === statements.length &&
    results.every((result) => result?.success === true) &&
    receipt?.results?.length === 1 &&
    receipt.results[0]?.live_render_final === 1;
  const output: ScanLiveRow[] = [];
  for (const group of groups) {
    if (!group) continue;
    const { plan } = group;
    const deliveredAt = ctx.clock.now();
    if (plan.expiresAt <= deliveredAt) continue;
    if (plan.visible && deliveredAt <= plan.visibleUntil && current(results, group.visible)) {
      let visible = plan.visible;
      if (
        plan.grant &&
        group.photo &&
        complete &&
        current(results, group.photo) &&
        plan.grant.plan.expiresAt > deliveredAt
      ) {
        const { grant } = plan;
        const token = takePhotoGrantToken(grant.actor, grant.passId, grant.plan);
        if (
          token &&
          plan.expiresAt > ctx.clock.now() &&
          plan.visibleUntil >= ctx.clock.now() &&
          grant.plan.expiresAt > ctx.clock.now()
        )
          visible = {
            ...visible,
            photoUrl: livePhotoUrl(grant.actor, grant.passId, token, visible.id),
          };
      }
      const finalAt = ctx.clock.now();
      if (plan.expiresAt <= finalAt) continue;
      if (plan.visibleUntil >= finalAt) output.push(visible);
      else if (plan.fallback && current(results, group.fallback)) output.push(plan.fallback);
    } else if (
      plan.fallback &&
      current(results, group.fallback) &&
      plan.expiresAt > ctx.clock.now()
    ) {
      output.push(plan.fallback);
    }
  }
  return output;
}
