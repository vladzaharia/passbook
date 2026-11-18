import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { headMatches, healHead, writeHead } from './head-store.ts';
import {
  type Receipt,
  type ReceiptBody,
  type ReceiptKind,
  receiptMac,
  verifyChain,
} from './receipts.ts';
import { chainHead, chainRows, insertReceipt, receiptInsertStmt } from './repo-receipts.ts';

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

async function bodyFor(ctx: ServiceContext, input: ReceiptInput) {
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
  return { body, head: head?.seq ?? 0, mac: await receiptMac(ctx.env, body) };
}

/**
 * Appends one receipt to the (org, class) chain. The chain head is read, the MAC computed, and the row lands
 * only while that head is still current; a racing writer makes it reread once.
 */
export async function writeReceipt(ctx: ServiceContext, input: ReceiptInput): Promise<Receipt> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { body, head, mac } = await bodyFor(ctx, input);
    if (await insertReceipt(ctx.env.DB, body, mac, head)) {
      await writeHead(ctx, { orgId: body.orgId, cls: body.cls, seq: body.seq, mac });
      return { ...body, mac };
    }
  }
  throw new ConflictError('Retention receipt chain is busy.', 'RETENTION_RECEIPT_BUSY');
}

export interface PreparedReceipt {
  /** Runs first in a batch; the delete it records is gated on this row existing. */
  stmt: D1PreparedStatement;
  receipt: Receipt;
}

/** A receipt as a statement, for a caller that commits it in the same batch as the delete it records. */
export async function prepareReceipt(
  ctx: ServiceContext,
  input: ReceiptInput,
  /** The insert lands only while this holds (the delete behind it is gated on the row). */
  gate?: { sql: string; params: readonly (string | number)[] },
): Promise<PreparedReceipt> {
  const { body, head, mac } = await bodyFor(ctx, input);
  return { stmt: receiptInsertStmt(ctx.env.DB, body, mac, head, gate), receipt: { ...body, mac } };
}

/** After the batch that carried a prepared receipt committed: records its head outside D1. */
export const recordHead = (ctx: ServiceContext, r: Receipt) =>
  writeHead(ctx, { orgId: r.orgId, cls: r.cls, seq: r.seq, mac: r.mac });

/** Every receipt of one chain with whether it verifies, oldest first. */
export async function readReceipts(
  ctx: ServiceContext,
  orgId: string | null,
  cls: string,
): Promise<{ receipt: Receipt; verified: boolean }[]> {
  const { rows, anchor } = await chainRows(ctx.env.DB, orgId, cls);
  const newest = rows.at(-1) ?? anchor;
  if (newest) await healHead(ctx, orgId, cls, { seq: newest.seq, mac: newest.mac });
  const headOk = await headMatches(
    ctx,
    orgId,
    cls,
    newest ? { seq: newest.seq, mac: newest.mac } : null,
  );
  return verifyChain(ctx.env, rows, anchor, headOk);
}
