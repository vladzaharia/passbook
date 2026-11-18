import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type Receipt,
  type ReceiptBody,
  type ReceiptKind,
  receiptMac,
  verifyChain,
} from './receipts.ts';
import { chainHead, chainRows, insertReceipt } from './repo-receipts.ts';

export interface ReceiptInput {
  /** NULL: the platform pass. */
  orgId: string | null;
  /** A data class, `visitors`, or `erasure`. */
  cls: string;
  kind: ReceiptKind;
  policyDays?: number | null;
  cutoffAt?: number | null;
  deleted: number;
  anonymised?: number;
  requestId?: string | null;
  /** SHA-256 over sorted pass refs (erasure, visitor). Never ids. */
  refsDigest?: string | null;
}

/**
 * Appends one receipt to the (org, class) chain. The chain head is read, the MAC computed, and the row lands
 * only while that head is still current; a racing writer makes it reread once.
 */
export async function writeReceipt(ctx: ServiceContext, input: ReceiptInput): Promise<Receipt> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await chainHead(ctx.env.DB, input.orgId, input.cls);
    const body: ReceiptBody = {
      id: ctx.ids.id(),
      orgId: input.orgId,
      cls: input.cls,
      kind: input.kind,
      policyDays: input.policyDays ?? null,
      cutoffAt: input.cutoffAt ?? null,
      deleted: input.deleted,
      anonymised: input.anonymised ?? 0,
      requestId: input.requestId ?? null,
      refsDigest: input.refsDigest ?? null,
      ranAt: ctx.clock.now(),
      seq: (head?.seq ?? 0) + 1,
      prevMac: head?.mac ?? null,
    };
    const mac = await receiptMac(ctx.env, body);
    if (await insertReceipt(ctx.env.DB, body, mac, head?.seq ?? 0)) return { ...body, mac };
  }
  throw new ConflictError('Retention receipt chain is busy.', 'RETENTION_RECEIPT_BUSY');
}

/** Every receipt of one chain with whether it verifies, oldest first. */
export async function readReceipts(
  ctx: ServiceContext,
  orgId: string | null,
  cls: string,
): Promise<{ receipt: Receipt; verified: boolean }[]> {
  const { rows, anchor } = await chainRows(ctx.env.DB, orgId, cls);
  return verifyChain(ctx.env, rows, anchor);
}
