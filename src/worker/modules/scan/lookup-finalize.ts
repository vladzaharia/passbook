import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { type LookupEntry, lookupHistoryStmts } from './lookup-history.ts';
import { photoGrantUrl, scannerPassActive } from './member-photo.ts';
import { type LookupPassRow, lookupPassesStmt } from './repo-lookup-final.ts';
import { scanAuthorizedStmt, scanReadAuthority } from './repo-read-authority.ts';
import { capturedReleaseId, passChanged } from './repo-resolve-outcome-current.ts';

/**
 * The entries still visible to the actor, in one batch: its authority, the passes' current standing
 * (`lookupPassesStmt`) and each last scan's pass lineage. Null when the actor no longer holds or
 * nothing of a non-empty page is visible. A release that changed how a lost pass is used is a real
 * race, not an absent pass: 409.
 */
export async function finalizeLookup(
  ctx: ServiceContext,
  actor: ScanActor,
  entries: readonly LookupEntry[],
  refs: readonly string[],
): Promise<LookupEntry[] | null> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const auth = scanReadAuthority(actor, { now });
  const passes = entries.length ? lookupPassesStmt(db, auth, actor, entries, refs) : null;
  if (entries.length && !passes) return null;
  const histories = entries.map((entry) =>
    entry.history ? lookupHistoryStmts(db, entry.history, now) : [],
  );
  const results = await db.batch<Record<string, unknown>>([
    scanAuthorizedStmt(db, auth),
    ...(passes ? [passes] : []),
    ...histories.flat(),
  ]);
  if (results[0]?.results?.[0]?.authorized !== 1) return null;
  const rows = new Map(
    ((results[1]?.results ?? []) as unknown as LookupPassRow[]).map((row) => [row.i, row]),
  );
  const visible: LookupEntry[] = [];
  let at = 2;
  for (const [index, entry] of entries.entries()) {
    const history = histories[index] ?? [];
    const historyCurrent =
      history.length > 0 &&
      history.every((_, offset) => results[at + offset]?.results?.[0]?.authorized === 1);
    at += history.length;
    const row = rows.get(index);
    // A Wallet that expired since the read is no longer a pass to list.
    if (!scannerPassActive(entry.source, entry.found.passJson, now)) continue;
    if (!row || row.pass_ok < 1) {
      // A release that changed how the pass is used is a real race, not an absent pass.
      if (row?.present === 1 && row.head !== capturedReleaseId(entry.source)) throw passChanged();
      continue;
    }
    entry.item.lastScanAt = historyCurrent ? entry.item.lastScanAt : null;
    entry.item.photoUrl =
      row.pass_ok === 2 && entry.photoGrant && entry.photoGrant.grant.expiresAt > now
        ? photoGrantUrl(actor, entry.source.pass.id, entry.photoGrant.grant)
        : null;
    visible.push(entry);
  }
  return visible.length === 0 && entries.length > 0 ? null : visible;
}
