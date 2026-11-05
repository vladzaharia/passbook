import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.ts';
import {
  createIds,
  fromBase64Url,
  safeEqual,
  safeEqualBytes,
  sha256Hex,
  toBase64Url,
  uuidv7,
} from './ids.ts';

describe('ids', () => {
  it('generates sortable UUIDv7 values', () => {
    const clock = new ManualClock(1_700_000_000_000);
    const ids = createIds(clock);
    const a = ids.id();
    clock.advance(5);
    const b = ids.id();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    expect(uuidv7(0x0123_4567_89ab, new Uint8Array(10)).startsWith('01234567-89ab-7')).toBe(true);
  });

  it('makes 256-bit url-safe tokens', () => {
    const token = createIds(new ManualClock()).token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromBase64Url(token)).toHaveLength(32);
  });

  it('makes zero-padded numeric codes', () => {
    const code = createIds(new ManualClock()).code(6);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('round-trips base64url', () => {
    const bytes = new Uint8Array([251, 255, 254, 0, 1]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it('hashes with sha256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compares in constant time semantics', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(safeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(false);
  });
});

describe('ordered ids', () => {
  it('keep creation order inside one millisecond', () => {
    const ids = createIds(new ManualClock());
    const made = Array.from({ length: 50 }, () => ids.ordered(1_700_000_000_000));
    expect([...made].sort()).toEqual(made);
    expect(new Set(made).size).toBe(50);
  });
});
