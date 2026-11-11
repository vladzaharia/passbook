import type { ApiKeyAuth } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertFeedKey } from './feed-projection.ts';
import {
  getApiKeyFeedRowsCurrent,
  getScanRowsByScopes,
  type ScanLogFilter,
  type ScanLogRow,
} from './repo-feed.ts';
import type { PasslessScan } from './scan-passless.ts';

/** Fence the exact selected rows and recover stale policy-bearing rows only as minimal history. */
export async function currentApiFeedSelection(
  ctx: ServiceContext,
  auth: ApiKeyAuth,
  filter: ScanLogFilter,
  rows: readonly ScanLogRow[],
  passless: Map<string, PasslessScan>,
  credentialKeysetCommitment: string,
  boundary?: ScanLogRow,
) {
  let current = await getApiKeyFeedRowsCurrent(
    ctx.env.DB,
    auth,
    filter,
    rows,
    ctx.clock.now(),
    credentialKeysetCommitment,
    passless,
    boundary,
  );
  assertFeedKey(current.status);
  let allowed = new Set(current.rows.map((row) => row.id));
  let selected = rows;
  const stale = rows.filter(
    (row) =>
      !allowed.has(row.id) &&
      row.policyAvailable &&
      (row.passId !== null || row.passlessProofCandidate),
  );
  if (stale.length) {
    const fresh = await getScanRowsByScopes(
      ctx.env.DB,
      stale.map((row) => ({ id: row.id, orgId: row.orgId, mode: row.mode })),
      ctx.clock.now(),
    );
    const byScope = new Map(fresh.map((row) => [`${row.orgId}\0${row.mode}\0${row.id}`, row]));
    selected = rows.flatMap((row): ScanLogRow[] => {
      if (allowed.has(row.id)) return [row];
      if (!row.policyAvailable || (row.passId === null && !row.passlessProofCandidate)) return [];
      const replacement = byScope.get(`${row.orgId}\0${row.mode}\0${row.id}`);
      if (!replacement || replacement.at !== row.at) return [];
      passless.delete(row.id);
      return [{ ...replacement, policyAvailable: false, eventProof: null, keySnapshot: null }];
    });
    current = await getApiKeyFeedRowsCurrent(
      ctx.env.DB,
      auth,
      filter,
      selected,
      ctx.clock.now(),
      credentialKeysetCommitment,
      passless,
      boundary,
    );
    assertFeedKey(current.status);
    allowed = new Set(current.rows.map((row) => row.id));
  }
  return { selected, allowed };
}
