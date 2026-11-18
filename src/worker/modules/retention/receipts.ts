// Retention receipts: append-only, MAC-chained per (org, class). Counts and a digest, never ids or content.
import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import { canonicalJson } from '../templates/package/hash.ts';

/** On the oldest KEK (not a rotatable label), like tombstones and scan retention proofs. */
export const RECEIPT_LABEL = 'retention-receipt.v1';

export type ReceiptKind = 'sweep' | 'visitor' | 'erasure';

/** Everything the MAC covers. */
export interface ReceiptBody {
  id: string;
  orgId: string | null;
  cls: string;
  kind: ReceiptKind;
  policyDays: number | null;
  cutoffAt: number | null;
  deleted: number;
  anonymised: number;
  requestId: string | null;
  refsDigest: string | null;
  ranAt: number;
  seq: number;
  prevMac: string | null;
}
export interface Receipt extends ReceiptBody {
  mac: string;
}

const encoder = new TextEncoder();

export async function receiptMac(env: object, body: ReceiptBody): Promise<string> {
  const key = await derivedHmacKey(env, RECEIPT_LABEL);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalJson(body)));
  return toHex(new Uint8Array(mac));
}

/** Constant-time check of a stored MAC. */
async function macMatches(env: object, body: ReceiptBody, mac: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(mac)) return false;
  const signature = Uint8Array.from(mac.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const key = await derivedHmacKey(env, RECEIPT_LABEL);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(canonicalJson(body)));
}

export const ANCHOR_LABEL = 'retention-receipt-anchor.v1';

/** The last receipt a 6-year sweep removed from a chain; the rest verify from it. MACed, so it cannot be forged. */
export interface Anchor {
  orgId: string | null;
  cls: string;
  seq: number;
  mac: string;
  ranAt: number;
  anchorMac: string;
}

const anchorBody = (a: Omit<Anchor, 'anchorMac'>) => ({
  orgId: a.orgId,
  cls: a.cls,
  seq: a.seq,
  mac: a.mac,
  ranAt: a.ranAt,
});

export async function anchorMac(env: object, a: Omit<Anchor, 'anchorMac'>): Promise<string> {
  const key = await derivedHmacKey(env, ANCHOR_LABEL);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalJson(anchorBody(a)))),
    ),
  );
}

async function anchorValid(env: object, a: Anchor): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(a.anchorMac)) return false;
  const signature = Uint8Array.from(a.anchorMac.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  const key = await derivedHmacKey(env, ANCHOR_LABEL);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(canonicalJson(anchorBody(a))));
}

/**
 * Marks each receipt of one chain. A receipt verifies when its MAC is right and it follows its predecessor:
 * seq +1 and `prevMac` equal to the predecessor's MAC. The first stored receipt follows the anchor, or is
 * seq 1 with no `prevMac`. Tampering with a column fails that row; a dropped or reordered row fails the
 * rows after the gap. An anchor that does not verify, or a chain whose newest receipt is below the head kept
 * outside D1 (`headOk` false: see head-store.ts), fails every receipt: nothing can be vouched for.
 */
export async function verifyChain(
  env: object,
  rows: readonly Receipt[],
  anchor: Anchor | null,
  headOk = true,
): Promise<{ receipt: Receipt; verified: boolean }[]> {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const base = headOk && (anchor === null || (await anchorValid(env, anchor)));
  const out: { receipt: Receipt; verified: boolean }[] = [];
  let prev: { seq: number; mac: string } | null = anchor;
  for (const receipt of sorted) {
    const { mac, ...body } = receipt;
    const links =
      prev === null
        ? receipt.seq === 1 && receipt.prevMac === null
        : receipt.seq === prev.seq + 1 && receipt.prevMac === prev.mac;
    const verified = base && links && (await macMatches(env, body, mac));
    out.push({ receipt, verified });
    prev = { seq: receipt.seq, mac: receipt.mac };
  }
  return out;
}
