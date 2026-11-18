import { all, batch, first, stmt } from '../../platform/db.ts';
import type { Anchor, Receipt, ReceiptBody } from './receipts.ts';

interface Raw {
  id: string;
  org_id: string | null;
  class: string;
  kind: Receipt['kind'];
  policy_days: number | null;
  cutoff_at: number | null;
  deleted: number;
  anonymised: number;
  request_id: string | null;
  refs_digest: string | null;
  ran_at: number;
  seq: number;
  prev_mac: string | null;
  mac: string;
}

const COLS = `id, org_id, class, kind, policy_days, cutoff_at, deleted, anonymised, request_id, refs_digest,
  ran_at, seq, prev_mac, mac`;

const toReceipt = (r: Raw): Receipt => ({
  id: r.id,
  orgId: r.org_id,
  cls: r.class,
  kind: r.kind,
  policyDays: r.policy_days,
  cutoffAt: r.cutoff_at,
  deleted: r.deleted,
  anonymised: r.anonymised,
  requestId: r.request_id,
  refsDigest: r.refs_digest,
  ranAt: r.ran_at,
  seq: r.seq,
  prevMac: r.prev_mac,
  mac: r.mac,
});

/** The newest receipt of a chain. `org_id IS ?` matches the platform pass (NULL). */
export async function chainHead(
  db: D1Database,
  orgId: string | null,
  cls: string,
): Promise<{ seq: number; mac: string } | null> {
  return first<{ seq: number; mac: string }>(
    db,
    'SELECT seq, mac FROM retention_receipts WHERE org_id IS ? AND class = ? ORDER BY seq DESC LIMIT 1',
    [orgId, cls],
  );
}

/**
 * Appends one receipt. It lands only while the chain head is still `head` (`seq` is `head + 1`); a racing
 * writer makes this a no-op and the caller rereads. Returns whether it was written.
 */
export function receiptInsertStmt(
  db: D1Database,
  body: ReceiptBody,
  mac: string,
  head: number,
  gate?: { sql: string; params: readonly (string | number)[] },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO retention_receipts (${COLS})
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE coalesce((SELECT max(seq) FROM retention_receipts WHERE org_id IS ? AND class = ?), 0) = ?
     ${gate ? `AND ${gate.sql}` : ''}`,
    [
      body.id,
      body.orgId,
      body.cls,
      body.kind,
      body.policyDays,
      body.cutoffAt,
      body.deleted,
      body.anonymised,
      body.requestId,
      body.refsDigest,
      body.ranAt,
      body.seq,
      body.prevMac,
      mac,
      body.orgId,
      body.cls,
      head,
      ...(gate?.params ?? []),
    ],
  );
}

export async function insertReceipt(
  db: D1Database,
  body: ReceiptBody,
  mac: string,
  head: number,
): Promise<boolean> {
  return (await receiptInsertStmt(db, body, mac, head).run()).meta.changes === 1;
}

export async function chainRows(
  db: D1Database,
  orgId: string | null,
  cls: string,
): Promise<{ rows: Receipt[]; anchor: Anchor | null }> {
  const [rows, anchor] = await Promise.all([
    all<Raw>(
      db,
      `SELECT ${COLS} FROM retention_receipts WHERE org_id IS ? AND class = ? ORDER BY seq`,
      [orgId, cls],
    ),
    first<{ seq: number; mac: string; ran_at: number; anchor_mac: string }>(
      db,
      'SELECT seq, mac, ran_at, anchor_mac FROM retention_receipt_anchors WHERE org_id IS ? AND class = ?',
      [orgId, cls],
    ),
  ]);
  return {
    rows: rows.map(toReceipt),
    anchor: anchor
      ? {
          orgId,
          cls,
          seq: anchor.seq,
          mac: anchor.mac,
          ranAt: anchor.ran_at,
          anchorMac: anchor.anchor_mac,
        }
      : null,
  };
}

/** Newest receipt per class of one org, for the summary. */
export async function lastReceiptRows(
  db: D1Database,
  orgId: string,
): Promise<{ cls: string; ranAt: number; deleted: number }[]> {
  const rows = await all<{ class: string; ran_at: number; deleted: number }>(
    db,
    `SELECT r.class, r.ran_at, r.deleted FROM retention_receipts r
     WHERE r.org_id = ? AND r.seq = (SELECT max(seq) FROM retention_receipts WHERE org_id = r.org_id AND class = r.class)
     ORDER BY r.class`,
    [orgId],
  );
  return rows.map((r) => ({ cls: r.class, ranAt: r.ran_at, deleted: r.deleted }));
}

export interface Chain {
  orgId: string | null;
  cls: string;
}

/** Chains with receipts older than `cutoff` that are not the newest of their chain. */
export async function chainsWithOld(
  db: D1Database,
  cutoff: number,
  limit: number,
): Promise<Chain[]> {
  const rows = await all<{ org_id: string | null; class: string }>(
    db,
    `SELECT DISTINCT org_id, class FROM retention_receipts r
     WHERE r.ran_at < ? AND r.seq < (SELECT max(seq) FROM retention_receipts
       WHERE org_id IS r.org_id AND class = r.class) LIMIT ?`,
    [cutoff, limit],
  );
  return rows.map((r) => ({ orgId: r.org_id, cls: r.class }));
}

/** The newest of the oldest `limit` receipts older than `cutoff`, never the newest of the chain. */
export async function trimTarget(
  db: D1Database,
  chain: Chain,
  cutoff: number,
  limit: number,
): Promise<{ seq: number; mac: string; ranAt: number } | null> {
  const r = await first<{ seq: number; mac: string; ran_at: number }>(
    db,
    `SELECT seq, mac, ran_at FROM (
       SELECT seq, mac, ran_at FROM retention_receipts r
       WHERE org_id IS ? AND class = ? AND ran_at < ?
         AND seq < (SELECT max(seq) FROM retention_receipts WHERE org_id IS r.org_id AND class = r.class)
       ORDER BY seq LIMIT ?) ORDER BY seq DESC LIMIT 1`,
    [chain.orgId, chain.cls, cutoff, limit],
  );
  return r ? { seq: r.seq, mac: r.mac, ranAt: r.ran_at } : null;
}

/**
 * Moves the chain's anchor forward to `anchor` and removes every receipt up to it, in one batch. The anchor
 * only moves forward (a stale one changes nothing, and the trigger refuses it). Returns how many went.
 */
export async function trimChain(db: D1Database, anchor: Anchor): Promise<number> {
  const [, removed] = await batch(db, [
    stmt(
      db,
      `INSERT INTO retention_receipt_anchors (org_id, class, seq, mac, ran_at, anchor_mac) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (ifnull(org_id, ''), class) DO UPDATE SET seq = excluded.seq, mac = excluded.mac,
         ran_at = excluded.ran_at, anchor_mac = excluded.anchor_mac WHERE excluded.seq > seq`,
      [anchor.orgId, anchor.cls, anchor.seq, anchor.mac, anchor.ranAt, anchor.anchorMac],
    ),
    stmt(db, 'DELETE FROM retention_receipts WHERE org_id IS ? AND class = ? AND seq <= ?', [
      anchor.orgId,
      anchor.cls,
      anchor.seq,
    ]),
  ]);
  return removed?.meta.changes ?? 0;
}
