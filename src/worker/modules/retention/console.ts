import type { z } from 'zod';
import type { ReceiptFileSchema, ReceiptSchema } from '../../../shared/contracts/retention.ts';
import { RETENTION_CLASSES } from '../../../shared/privacy/data-classes.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { listHoldViews } from './hold-view.ts';
import { readReceipts } from './receipt-service.ts';

type ReceiptItem = z.infer<typeof ReceiptSchema>;
type ReceiptFile = z.infer<typeof ReceiptFileSchema>;

export { listHoldViews };

/** Chains an org has (the platform pass, org null, has the seven classes): the seven classes, visitor deletions (same name) and erasure. */
const CLASSES = [...new Set<string>([...RETENTION_CLASSES, 'visitors', 'erasure'])];

async function allReceipts(ctx: ServiceContext, orgId: string | null) {
  const chains = await Promise.all(CLASSES.map((cls) => readReceipts(ctx, orgId, cls)));
  return chains
    .flat()
    .sort((a, b) => b.receipt.ranAt - a.receipt.ranAt || b.receipt.seq - a.receipt.seq);
}

/** Newest first, 200 at most. No MAC and no ids of anything deleted: counts, cutoff and policy. */
export async function listReceiptItems(
  ctx: ServiceContext,
  orgId: string | null,
): Promise<ReceiptItem[]> {
  return (await allReceipts(ctx, orgId)).slice(0, 200).map(({ receipt: r, verified }) => ({
    id: r.id,
    cls: r.cls,
    kind: r.kind,
    ranAt: r.ranAt,
    cutoffAt: r.cutoffAt,
    policyDays: r.policyDays,
    deleted: r.deleted,
    anonymised: r.anonymised,
    verified,
  }));
}

/** One receipt of this org with what it takes to check it offline. Another org's id is a 404. */
export async function receiptFile(
  ctx: ServiceContext,
  orgId: string | null,
  receiptId: string,
): Promise<ReceiptFile> {
  const found = (await allReceipts(ctx, orgId)).find(({ receipt }) => receipt.id === receiptId);
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
