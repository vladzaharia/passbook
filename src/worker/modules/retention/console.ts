import type { z } from 'zod';
import type { ReceiptFileSchema, ReceiptSchema } from '../../../shared/contracts/retention.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { listHoldViews } from './hold-view.ts';
import { readReceipts } from './receipt-service.ts';
import type { Receipt } from './receipts.ts';
import { receiptClass, receiptPageRows } from './repo-receipts.ts';

type ReceiptItem = z.infer<typeof ReceiptSchema>;
type ReceiptFile = z.infer<typeof ReceiptFileSchema>;

export { listHoldViews };

/** Each receipt's verdict, reading each involved chain once and writing nothing. */
async function verdicts(ctx: ServiceContext, orgId: string | null, receipts: readonly Receipt[]) {
  const out = new Map<string, boolean>();
  for (const cls of new Set(receipts.map((r) => r.cls)))
    for (const { receipt, verified } of await readReceipts(ctx, orgId, cls, false))
      out.set(receipt.id, verified);
  return out;
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  const m = /^(\d+)\.([^.\s]{1,64})$/.exec(cursor);
  if (!m) throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return { ranAt: Number(m[1]), id: m[2] as string };
}

/** Newest first. No MAC and no ids of anything deleted: counts, cutoff and policy. */
export async function listReceiptItems(
  ctx: ServiceContext,
  orgId: string | null,
  query: { cursor?: string | undefined; limit: number },
): Promise<{ items: ReceiptItem[]; nextCursor: string | null }> {
  const rows = await receiptPageRows(
    ctx.env.DB,
    orgId,
    decodeCursor(query.cursor),
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  const verified = await verdicts(ctx, orgId, page);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      cls: r.cls,
      kind: r.kind,
      ranAt: r.ranAt,
      cutoffAt: r.cutoffAt,
      policyDays: r.policyDays,
      deleted: r.deleted,
      anonymised: r.anonymised,
      verified: verified.get(r.id) ?? false,
    })),
    nextCursor: rows.length > query.limit && last ? `${last.ranAt}.${last.id}` : null,
  };
}

/** One receipt of this org with what it takes to check it offline. Another org's id is a 404. */
export async function receiptFile(
  ctx: ServiceContext,
  orgId: string | null,
  receiptId: string,
): Promise<ReceiptFile> {
  const cls = await receiptClass(ctx.env.DB, orgId, receiptId);
  const found = cls
    ? (await readReceipts(ctx, orgId, cls, false)).find(({ receipt }) => receipt.id === receiptId)
    : undefined;
  if (!found) throw new NotFoundError('Receipt not found.', 'RECEIPT_NOT_FOUND');
  const { receipt: r, verified } = found;
  return {
    receipt: {
      id: r.id,
      orgId: r.orgId,
      cls: r.cls,
      kind: r.kind,
      ranAt: r.ranAt,
      cutoffAt: r.cutoffAt,
      policyDays: r.policyDays,
      deleted: r.deleted,
      anonymised: r.anonymised,
      verified,
      seq: r.seq,
      prevMac: r.prevMac,
      mac: r.mac,
      refsDigest: r.refsDigest,
      requestId: r.requestId,
    },
  };
}
