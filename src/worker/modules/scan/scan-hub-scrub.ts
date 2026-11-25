import type { ServiceContext } from '../../platform/service-context.ts';
import { type LiveRingRow, scrubbedEntry } from './live-ring.ts';
import { liveRingStaleStmt } from './repo-live-render.ts';

/**
 * Strip identity from entries whose pass is no longer visible (deleted, erased, transferred,
 * released elsewhere) or whose Wallet has expired, so a holder's name does not sit in storage
 * until the TTL. The redacted event stays.
 */
export async function scrubRing(
  storage: DurableObjectStorage,
  ctx: ServiceContext,
  ring: LiveRingRow[],
): Promise<LiveRingRow[]> {
  const tenant = await storage.get<string>('tenant');
  const [orgId, mode] = tenant?.split(':') ?? [];
  const withPass = ring.filter((e) => e.gen !== null);
  if (!orgId || !mode || !withPass.length) return ring;
  const now = ctx.clock.now();
  let stale: Set<number>;
  try {
    const { results } = await liveRingStaleStmt(ctx.env.DB, orgId, mode, ring).all<{
      i: number;
    }>();
    stale = new Set(results.map((r) => r.i));
  } catch {
    ctx.log.warn('scan.live_scrub_failed', { orgId, code: 'SCAN_LIVE_SCRUB_FAILED' });
    return ring;
  }
  return ring.map((e, i) =>
    e.gen !== null && (stale.has(i) || (e.validUntil !== null && now > e.validUntil))
      ? scrubbedEntry(e)
      : e,
  );
}
