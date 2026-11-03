import { describe, expect, it } from 'vitest';
import { decodeIco, encodeIco } from './ico.ts';

describe('encodeIco', () => {
  it('writes a directory the frames can be read back from', () => {
    const frames = [
      { size: 16, png: Uint8Array.of(1, 2, 3) },
      { size: 256, png: Uint8Array.of(4, 5) },
    ];
    const ico = encodeIco(frames);
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]);
    // 256 is stored as 0; 32 bits per pixel, one plane.
    expect(ico[6 + 16]).toBe(0);
    expect(ico.readUInt16LE(6 + 6)).toBe(32);
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
    expect(decodeIco(ico).map((f) => [f.size, [...f.png]])).toEqual([
      [16, [1, 2, 3]],
      [256, [4, 5]],
    ]);
  });

  it('refuses frames ICO cannot hold', () => {
    expect(() => encodeIco([{ size: 512, png: Uint8Array.of(0) }])).toThrow('1–256');
  });
});
