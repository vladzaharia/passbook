import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { takePhotoGrantToken } from './asset-sidecar.ts';
import type { LiveRecipient } from './live-auth.ts';
import { livePhotoUrl, type PreparedLiveRow } from './live-render-plan.ts';
import { isAssetGrantAuthorityFailure } from './repo-asset-grants.ts';
import {
  type LiveRenderFence,
  liveRenderFence,
  liveRenderReceiptStmt,
  liveRenderVisibilityPredicate,
} from './repo-live-render-final.ts';

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

/** Commit every catch-up row and its optional photo grant in one atomic D1 transaction. */
export async function finishLiveRows(
  ctx: ServiceContext,
  recipient: LiveRecipient,
  plans: readonly (PreparedLiveRow | null)[],
): Promise<ScanLiveRow[]> {
  const db = ctx.env.DB;
  // Every asynchronous proof and grant plan has completed before this common final clock.
  const now = ctx.clock.now();
  const build = (grantable: (index: number) => boolean) => {
    const statements: D1PreparedStatement[] = [];
    const groups = plans.map((plan, index) => {
      if (!plan || plan.expiresAt <= now) return null;
      const fresh = plan.freshAt(now);
      if (!fresh) return null;
      const visibleFresh = Number.isFinite(plan.visibleUntil)
        ? [...fresh, liveRenderVisibilityPredicate(now, plan.visibleUntil)]
        : fresh;
      const visible =
        plan.visibleFences && now <= plan.visibleUntil
          ? liveRenderFence(
              db,
              [...plan.visibleFences, ...visibleFresh],
              recipient.actor.orgId,
              recipient.actor.mode,
              index,
              1,
            )
          : null;
      const fallback = plan.fallbackFences
        ? liveRenderFence(
            db,
            [...plan.fallbackFences, ...fresh],
            recipient.actor.orgId,
            recipient.actor.mode,
            index,
            2,
          )
        : null;
      const start = statements.length;
      let grantCount = 0;
      if (
        plan.visible &&
        visible &&
        plan.grant &&
        plan.grant.plan.expiresAt > now &&
        grantable(index)
      ) {
        const grantStatements = plan.grant.statementsAt(now, visibleFresh);
        statements.push(...grantStatements);
        grantCount = grantStatements.length;
      }
      if (visible) statements.push(...visible.statements);
      if (fallback) statements.push(...fallback.statements);
      return { plan, start, grantCount, visible, fallback };
    });
    // This receipt makes a missing or damaged trailing result incapable of releasing a grant token.
    if (statements.length) statements.push(liveRenderReceiptStmt(db));
    return { statements, groups };
  };
  let { statements, groups } = build(() => true);
  if (!statements.length) return [];
  let results: D1Result<LiveRenderResultRow>[];
  try {
    results = await db.batch<LiveRenderResultRow>(statements);
  } catch (error) {
    if (!isAssetGrantAuthorityFailure(error)) throw error;
    // The sentinel rolled the entire grant transaction back. Recheck every row in one
    // read-only transaction so one stale event cannot suppress unrelated events.
    const reads: D1PreparedStatement[] = [];
    for (const group of groups) {
      if (group?.visible) reads.push(...group.visible.statements);
      if (group?.fallback) reads.push(...group.fallback.statements);
    }
    if (!reads.length) return [];
    const rechecked = await db.batch<LiveRenderResultRow>(reads);
    results = rechecked;
    // Epoch staleness shows only in SQL. Retry the grants of rows that are still visible once,
    // so one stale event cannot strip every other photo.
    const granted = groups.flatMap((group, index) =>
      group && group.grantCount > 0 ? [index] : [],
    );
    const retry = new Set(
      granted.filter((index) => current(rechecked, groups[index]?.visible ?? null)),
    );
    if (retry.size > 0 && retry.size < granted.length) {
      const second = build((index) => retry.has(index));
      try {
        results = await db.batch<LiveRenderResultRow>(second.statements);
        ({ statements, groups } = second);
      } catch (retryError) {
        if (!isAssetGrantAuthorityFailure(retryError)) throw retryError;
        results = rechecked;
      }
    }
  }
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
        group.grantCount > 0 &&
        complete &&
        plan.grant.plan.expiresAt > deliveredAt
      ) {
        const { grant } = plan;
        const slice = results.slice(group.start, group.start + group.grantCount);
        const token = takePhotoGrantToken(grant.actor, grant.passId, grant.plan, slice);
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
