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

/** The last receipt a 6-year sweep removed from a chain; the rest verify from it. */
export interface Anchor {
  seq: number;
  mac: string;
}

/**
 * Marks each receipt of one chain. A receipt verifies when its MAC is right and it follows its predecessor:
 * seq +1 and `prevMac` equal to the predecessor's MAC. The first stored receipt follows the anchor, or is
 * seq 1 with no `prevMac`. Tampering with a column fails that row; a dropped or reordered row fails the
 * rows after the gap. Dropping the newest receipt leaves a valid shorter chain: the receipts table refuses
 * deletes, and a caller holding the expected head can compare it.
 */
export async function verifyChain(
  env: object,
  rows: readonly Receipt[],
  anchor: Anchor | null,
): Promise<{ receipt: Receipt; verified: boolean }[]> {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const out: { receipt: Receipt; verified: boolean }[] = [];
  let prev: Anchor | null = anchor;
  for (const receipt of sorted) {
    const { mac, ...body } = receipt;
    const links =
      prev === null
        ? receipt.seq === 1 && receipt.prevMac === null
        : receipt.seq === prev.seq + 1 && receipt.prevMac === prev.mac;
    const verified = links && (await macMatches(env, body, mac));
    out.push({ receipt, verified });
    prev = { seq: receipt.seq, mac: receipt.mac };
  }
  return out;
}
