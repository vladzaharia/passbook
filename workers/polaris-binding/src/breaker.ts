import { alert, type Meta, noteCall } from './ledger.ts';
import { IdpError } from './types.ts';

/** One run (`ref`: a drain or reconcile run) may remove this many roles and disable this many accounts. */
export const MAX_REMOVALS = 25;
export const MAX_DISABLES = 5;

/**
 * Claims removals and disables for a run before they are sent, in one conditional update. Past a limit the run
 * stops with `IDP_BREAKER`: a D1 incident that reads memberships as empty cannot strip everyone.
 */
export async function claim(
  db: D1Database,
  meta: Meta,
  use: { removals?: number; disables?: number },
  at: number,
): Promise<void> {
  const removals = use.removals ?? 0;
  const disables = use.disables ?? 0;
  if (!meta.ref || (removals === 0 && disables === 0)) return;
  await db
    .prepare('INSERT OR IGNORE INTO idp_breaker (ref, removals, disables, at) VALUES (?, 0, 0, ?)')
    .bind(meta.ref, at)
    .run();
  const res = await db
    .prepare(
      `UPDATE idp_breaker SET removals = removals + ?2, disables = disables + ?3
       WHERE ref = ?1 AND removals + ?2 <= ${MAX_REMOVALS} AND disables + ?3 <= ${MAX_DISABLES}`,
    )
    .bind(meta.ref, removals, disables)
    .run();
  if (res.meta.changes === 1) return;
  await noteCall(db, 'breaker', meta, at, 'IDP_BREAKER');
  alert('error', 'binding.breaker', { method: meta.method, ref: meta.ref });
  throw new IdpError('IDP_BREAKER', 'This run reached its limit of changes.');
}
