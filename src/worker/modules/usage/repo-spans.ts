import { all, run } from '../../platform/db.ts';
import { type LiveSpan, SPAN_IDLE_MS, type SpanEndReason, type SpanPlatform } from './spans.ts';

interface SpanRow {
  id: string;
  org_id: string;
  pass_id: string;
  platform: SpanPlatform;
  live_from: number;
  live_to: number | null;
  end_reason: SpanEndReason | null;
  expires_at: number | null;
  last_used_at: number;
}

function toSpan(row: SpanRow): LiveSpan {
  return {
    id: row.id,
    orgId: row.org_id,
    passId: row.pass_id,
    platform: row.platform,
    liveFrom: row.live_from,
    liveTo: row.live_to,
    endReason: row.end_reason,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

/** A pass's spans, oldest first. */
export async function spansOfPass(db: D1Database, passId: string): Promise<LiveSpan[]> {
  const rows = await all<SpanRow>(
    db,
    'SELECT * FROM pass_live_spans WHERE pass_id = ? ORDER BY live_from, id',
    [passId],
  );
  return rows.map(toSpan);
}

/**
 * Stamps the effective end on open spans that have expired or gone idle by `now`, at most `limit` per call.
 * The end is the one the gauge already reads (`pass_live_spans_effective`), so this only tidies.
 */
export async function closeEndedSpans(db: D1Database, now: number, limit: number): Promise<number> {
  const end = `MIN(COALESCE(expires_at, ${Number.MAX_SAFE_INTEGER}), last_used_at + ${SPAN_IDLE_MS})`;
  const { changes } = await run(
    db,
    `UPDATE pass_live_spans
     SET live_to = MAX(live_from, ${end}),
       end_reason = CASE WHEN COALESCE(expires_at, ${Number.MAX_SAFE_INTEGER}) <= last_used_at + ${SPAN_IDLE_MS}
         THEN 'expiry' ELSE 'idle' END
     WHERE id IN (SELECT id FROM pass_live_spans WHERE live_to IS NULL AND ${end} <= ? LIMIT ?)`,
    [now, limit],
  );
  return changes;
}
