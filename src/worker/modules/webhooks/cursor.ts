import { keyedDigest } from '../../platform/crypto.ts';
import type { FeedFence } from './repo-feed.ts';

/**
 * Cursors carry the journal `seq` XORed with a 40-bit mask keyed per org and mode, so a tenant cannot read
 * the platform-wide event volume from them. The result is a plain number: the format stays `ev1.<digits>`.
 * Zero is the start of the feed and stays zero.
 */
async function maskOf(env: object, fence: FeedFence): Promise<bigint> {
  const hex = (await keyedDigest(env, 'webhook.cursor.v1', `${fence.orgId}:${fence.mode}`)).slice(
    0,
    10,
  );
  return BigInt(`0x${hex}`);
}

export async function encodeSeq(env: object, fence: FeedFence, seq: number): Promise<string> {
  if (seq === 0) return '0';
  return String(BigInt(seq) ^ (await maskOf(env, fence)));
}

/** A cursor is trusted for nothing: a decoded value outside any tenant row just pages to an empty tail. */
export async function decodeSeq(env: object, fence: FeedFence, digits: string): Promise<number> {
  if (digits === '0') return 0;
  const seq = BigInt(digits) ^ (await maskOf(env, fence));
  return seq > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(seq);
}
