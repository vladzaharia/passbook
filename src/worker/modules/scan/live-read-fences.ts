import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { liveReadFenceStmts } from './repo-live-read-fences.ts';

type Predicate = { sql: string; params: readonly SqlValue[] };

/** Evaluate independently bindable fences in one snapshot, identifying every result structurally. */
export async function livePredicatesCurrent(
  ctx: ServiceContext,
  pieces: readonly Predicate[],
  orgId: string,
  mode: string,
): Promise<boolean> {
  const statements = liveReadFenceStmts(ctx.env.DB, pieces, orgId, mode);
  if (!statements) return false;
  const results = await ctx.env.DB.batch(statements);
  if (results.length !== statements.length) return false;
  const seen = new Set<number>();
  for (const result of results) {
    const row = result?.results?.[0] as
      | { current?: unknown; live_authority_part?: unknown }
      | undefined;
    const part = row?.live_authority_part;
    if (
      result?.success !== true ||
      result.results?.length !== 1 ||
      row?.current !== 1 ||
      typeof part !== 'number' ||
      !Number.isInteger(part) ||
      part < 0 ||
      part >= statements.length ||
      seen.has(part)
    )
      return false;
    seen.add(part);
  }
  return true;
}
