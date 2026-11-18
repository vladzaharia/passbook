// The newest receipt of each chain, written outside D1 so a database writer cannot drop the tail unseen.
// One immutable object per receipt: with an R2 bucket lock on `retention/receipts/` none can be overwritten
// or deleted (deploy prerequisite, see docs/operations.md).
import type { ServiceContext } from '../../platform/service-context.ts';

const pad = (seq: number) => String(seq).padStart(12, '0');
const prefix = (orgId: string | null, cls: string) =>
  `retention/receipts/${orgId ?? 'platform'}/${cls}/`;
const keyOf = (orgId: string | null, cls: string, seq: number) =>
  `${prefix(orgId, cls)}${pad(seq)}.json`;

/** Records a receipt's (seq, mac). A failure is logged: the receipt is already in D1, and the next append heals it. */
export async function writeHead(
  ctx: ServiceContext,
  r: { orgId: string | null; cls: string; seq: number; mac: string },
): Promise<void> {
  try {
    await ctx.env.BUCKET.put(
      keyOf(r.orgId, r.cls, r.seq),
      JSON.stringify({ seq: r.seq, mac: r.mac }),
      {
        httpMetadata: { contentType: 'application/json' },
      },
    );
  } catch (error) {
    ctx.log.error('retention.head_write_failed', {
      cls: r.cls,
      code: 'RETENTION_HEAD_WRITE_FAILED',
      error,
    });
  }
}

/**
 * True when D1's newest receipt is the newest recorded outside D1: its object exists with the same MAC and no
 * later object does. An empty chain is fine only when nothing was ever recorded.
 */
export async function headMatches(
  ctx: ServiceContext,
  orgId: string | null,
  cls: string,
  newest: { seq: number; mac: string } | null,
): Promise<boolean> {
  const bucket = ctx.env.BUCKET;
  if (newest === null)
    return (await bucket.list({ prefix: prefix(orgId, cls), limit: 1 })).objects.length === 0;
  const later = await bucket.list({
    prefix: prefix(orgId, cls),
    startAfter: keyOf(orgId, cls, newest.seq),
    limit: 1,
  });
  if (later.objects.length > 0) return false;
  const object = await bucket.get(keyOf(orgId, cls, newest.seq));
  if (!object) return false;
  const stored = (await object.json()) as { mac?: unknown };
  return stored.mac === newest.mac;
}
