import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha1Hex } from './sha1.ts';

const node = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex');

describe('sha1Hex', () => {
  it('matches the known vectors', () => {
    expect(sha1Hex(new Uint8Array())).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex(new TextEncoder().encode('abc'))).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
  });
  it('matches node:crypto across block boundaries', () => {
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(sha1Hex(bytes), `length ${n}`).toBe(node(bytes));
    }
  });
});
