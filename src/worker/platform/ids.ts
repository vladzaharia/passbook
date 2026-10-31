import type { Clock } from './clock.ts';

const encoder = new TextEncoder();

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

export async function sha256Base64Url(data: string | Uint8Array): Promise<string> {
  return toBase64Url(await sha256(data));
}

/** Constant-time string comparison (compares fixed-length digests, so length does not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < da.length; i++) diff |= (da[i] ?? 0) ^ (db[i] ?? 0);
  return diff === 0;
}

/** Constant-time comparison of two equal-purpose byte arrays. */
export function safeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length === b.length ? 0 : 1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** UUIDv7: 48-bit ms timestamp, version 7, random remainder. Sortable by creation time. */
export function uuidv7(nowMs: number, random: Uint8Array = randomBytes(10)): string {
  const bytes = new Uint8Array(16);
  const time = BigInt(nowMs);
  for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn);
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Id and token generation, injected so tests are deterministic. */
export interface Ids {
  /** Time-ordered primary key (UUIDv7). */
  id(): string;
  /** URL-safe random token with `bytes` of entropy (default 256 bits). */
  token(bytes?: number): string;
  /** Random decimal code, zero padded. */
  code(digits?: number): string;
}

export function createIds(clock: Clock): Ids {
  return {
    id: () => uuidv7(clock.now()),
    token: (bytes = 32) => toBase64Url(randomBytes(bytes)),
    code: (digits = 6) => {
      const max = 10 ** digits;
      const limit = Math.floor(0x1_0000_0000 / max) * max;
      let n: number;
      do {
        n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
      } while (n >= limit);
      return String(n % max).padStart(digits, '0');
    },
  };
}

/** Sequential ids and tokens for tests. */
export function createSequentialIds(prefix = 'id'): Ids {
  let n = 0;
  return {
    id: () => `${prefix}-${String(++n).padStart(6, '0')}`,
    token: () => `${prefix}-token-${String(++n).padStart(6, '0')}`,
    code: (digits = 6) => String(++n).padStart(digits, '0'),
  };
}
