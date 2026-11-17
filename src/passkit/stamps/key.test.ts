import { describe, expect, it } from 'vitest';
import type { StampsManifest } from '../types.ts';
import { stampKey } from './key.ts';

const block: StampsManifest = {
  input: 'stamps',
  goal: 10,
  art: { filled: 'stamps/filled.png', empty: 'stamps/empty.png' },
};
const files: Record<string, string> = {
  'stamps/filled.png': 'a',
  'stamps/empty.png': 'b',
  'strip@2x.png': 'c',
};
const key = (b: StampsManifest, f = files) => stampKey(b, (name) => f[name]);

describe('stamp key', () => {
  it('is stable and follows everything the strips depend on', async () => {
    const base = await key(block);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await key({ ...block })).toBe(base);
    expect(await key({ ...block, input: 'visits' })).toBe(base);
    const others = await Promise.all([
      key({ ...block, goal: 8 }),
      key({ ...block, tilt: false }),
      key({ ...block, art: { ...block.art, reward: 'stamps/filled.png' } }),
      key(block, { ...files, 'stamps/filled.png': 'z' }),
      key(block, { ...files, 'strip@3x.png': 'd' }),
    ]);
    expect(new Set([base, ...others]).size).toBe(6);
  });
});
