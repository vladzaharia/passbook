import { derivedHmacKey, keyedDigest } from '../../platform/crypto.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { FeedFence } from './repo-feed.ts';

/**
 * A cursor body is one AES-256 block, `seq` (8 bytes, big endian) plus a tag of the org and mode (8 bytes),
 * enciphered under a key derived from the platform secret and written as 22 base64url characters
 * (`ev2.<body>`). It is a keyed permutation, so a tenant can read neither the platform-wide event
 * volume nor the distance between its own cursors, and a cursor of another org or mode fails the tag.
 *
 * `AES-CBC` with a zero IV over exactly one block is the deterministic ECB block cipher; WebCrypto
 * only exposes CBC, so decrypting appends the padding block it expects.
 */
const LABEL = 'webhook.cursor.v2';
const ZERO_IV = new Uint8Array(16);
const encoder = new TextEncoder();
const BODY = /^[A-Za-z0-9_-]{22}$/;

export const invalidCursor = () => new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');

async function hmac(env: object, data: string): Promise<Uint8Array> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await derivedHmacKey(env, LABEL),
    encoder.encode(data),
  );
  return new Uint8Array(mac);
}

async function aesKey(env: object): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', await hmac(env, 'aes-256-key'), 'AES-CBC', false, [
    'encrypt',
    'decrypt',
  ]);
}

const tagOf = async (env: object, f: FeedFence) =>
  (await hmac(env, `tag:${f.orgId}:${f.mode}`)).slice(0, 8);

const b64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const unb64 = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** The 22-character body of an `ev2.` cursor, for `seq` of this org and mode. */
export async function encodeCursor(env: object, fence: FeedFence, seq: number): Promise<string> {
  const block = new Uint8Array(16);
  new DataView(block.buffer).setBigUint64(0, BigInt(seq));
  block.set(await tagOf(env, fence), 8);
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: ZERO_IV },
    await aesKey(env),
    block,
  );
  return b64(new Uint8Array(out).slice(0, 16));
}

async function decodeBody(env: object, fence: FeedFence, body: string): Promise<number> {
  if (!BODY.test(body)) throw invalidCursor();
  const key = await aesKey(env);
  const c1 = unb64(body);
  // Only the canonical encoding: the last character carries 4 unused bits.
  if (c1.length !== 16 || b64(c1) !== body) throw invalidCursor();
  // The padding block that makes a one-block ciphertext a valid CBC message: E(pad xor c1).
  const pad = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: c1 }, key, new Uint8Array(0)),
  );
  const joined = new Uint8Array(32);
  joined.set(c1);
  joined.set(pad.slice(0, 16), 16);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, joined),
    );
  } catch {
    throw invalidCursor();
  }
  const tag = await tagOf(env, fence);
  // A different org or mode (or a forged block) does not carry this tenant's tag.
  if (plain.length !== 16 || !tag.every((byte, i) => byte === plain[8 + i])) throw invalidCursor();
  const seq = new DataView(plain.buffer, plain.byteOffset).getBigUint64(0);
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidCursor();
  return Number(seq);
}

/**
 * `ev1.<digits>` cursors, issued before `ev2`, are accepted for one more release. They hold the journal
 * `seq` XORed with a 40-bit mask keyed per org and mode; `ev1.0` is the start of the feed.
 */
async function decodeLegacy(env: object, fence: FeedFence, digits: string): Promise<number> {
  if (digits === '0') return 0;
  const hex = (await keyedDigest(env, 'webhook.cursor.v1', `${fence.orgId}:${fence.mode}`)).slice(
    0,
    10,
  );
  const seq = BigInt(digits) ^ BigInt(`0x${hex}`);
  return seq > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(seq);
}

/** A cursor as a client sends it: `ev2.<body>`, a legacy `ev1.<digits>`, or a bare body or legacy digits. */
export async function decodeCursor(env: object, fence: FeedFence, cursor: string): Promise<number> {
  const m = /^(?:(ev[12])\.)?(.+)$/.exec(cursor);
  const prefix = m?.[1];
  const rest = m?.[2] ?? '';
  const legacy = prefix === 'ev1' || (prefix === undefined && /^\d{1,15}$/.test(rest));
  if (legacy) return decodeLegacy(env, fence, rest);
  return decodeBody(env, fence, rest);
}
