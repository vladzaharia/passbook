import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha1Hex } from '../sign/index.ts';
import { compositorMemory, renderStrip, type StampArt } from './compose.ts';
import { GOAL_MAX, GOAL_MIN } from './layout.ts';
import { decodePng, encodePng, PngError, type Rgba } from './png.ts';
import { stampStrips } from './strips.ts';

const dir = join(process.cwd(), 'templates/starter-stamp-card');
const read = (name: string) => decodePng(new Uint8Array(readFileSync(join(dir, name))));
const art: StampArt = {
  filled: read('stamps/filled.png'),
  empty: read('stamps/empty.png'),
  reward: read('stamps/reward.png'),
  rewardEarned: read('stamps/reward-earned.png'),
};
const base = { 2: read('strip@2x.png'), 3: read('strip@3x.png') };
const hash = async (img: Rgba) => sha1Hex(encodePng(img));

describe('renderStrip', () => {
  it('is deterministic', async () => {
    const req = { goal: 10, count: 7, scale: 2, base: base[2], art } as const;
    expect(await hash(renderStrip(req))).toBe(await hash(renderStrip(req)));
  });

  it('matches its golden hashes', async () => {
    const at = (scale: 2 | 3) => renderStrip({ goal: 10, count: 7, scale, base: base[scale], art });
    expect([await hash(at(2)), await hash(at(3))]).toEqual(GOLDEN_G10_C7);
  });

  it('changes one disc per stamp', () => {
    const a = renderStrip({ goal: 10, count: 4, scale: 2, base: base[2], art });
    const b = renderStrip({ goal: 10, count: 5, scale: 2, base: base[2], art });
    let changed = 0;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) changed++;
    expect(changed).toBeGreaterThan(0);
    // Everything left of the fifth disc is untouched: compare the first pixel column.
    expect(a.data.subarray(0, 4)).toEqual(b.data.subarray(0, 4));
  });

  it('draws a full card for counts above the goal', async () => {
    const full = renderStrip({ goal: 8, count: 8, scale: 2, base: base[2], art });
    const over = renderStrip({ goal: 8, count: 15, scale: 2, base: base[2], art });
    expect(await hash(over)).toBe(await hash(full));
  });

  it('keeps a transparent base transparent where nothing is drawn', () => {
    const img = renderStrip({ goal: 5, count: 0, scale: 2, base: 'transparent', art });
    expect(img.data[3]).toBe(0);
    expect(img.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it('falls back to empty and filled when reward art is absent', () => {
    const plain: StampArt = { filled: art.filled, empty: art.empty };
    expect(() =>
      renderStrip({ goal: 6, count: 6, scale: 3, base: 'transparent', art: plain }),
    ).not.toThrow();
  });

  it('refuses a base of the wrong size', () => {
    expect(() => renderStrip({ goal: 6, count: 1, scale: 2, base: base[3], art })).toThrow(
      RangeError,
    );
  });

  it('refuses bytes that are not a PNG', () => {
    expect(() => decodePng(new Uint8Array(40))).toThrow(PngError);
  });
});

describe('stampStrips', () => {
  it.each([GOAL_MIN, 10, GOAL_MAX])(
    'goal %i yields two files per count with exact sizes',
    (goal) => {
      const strips = stampStrips({ goal, art, base });
      expect(strips).toHaveLength(2 * (goal + 1));
      expect(new Set(strips.map((s) => s.name)).size).toBe(strips.length);
      for (const s of strips) {
        expect(s.width).toBe(375 * s.scale);
        expect(s.height).toBe(144 * s.scale);
        expect(s.bytes.length).toBeLessThan(400 * 1024);
      }
    },
  );

  it('renders the same bytes twice', async () => {
    const a = stampStrips({ goal: 6, art, base, counts: [3] });
    const b = stampStrips({ goal: 6, art, base, counts: [3] });
    expect(await sha1Hex(a[0]?.bytes as Uint8Array)).toBe(await sha1Hex(b[0]?.bytes as Uint8Array));
  });

  it('keeps a goal-20 version under the Worker CPU limit', () => {
    // cpu_ms is 10000 in production; 8000 on a quiet machine leaves room. Coverage
    // instrumentation (v8) slows every script several times over, so the budget scales with a
    // fixed reference kernel timed in this process: 250 ms on the machine the 8000 was set on,
    // and about 5x that under coverage, where the drawing is 6x slower.
    const cpu = (run: () => void) => {
      const t = process.cpuUsage();
      run();
      const used = process.cpuUsage(t);
      return (used.user + used.system) / 1000;
    };
    const reference = cpu(() => {
      const a = new Float32Array(1 << 16);
      const b = new Float32Array(1 << 16);
      let sum = 0;
      for (let k = 0; k < 3000; k++)
        for (let i = 0; i < a.length; i++) {
          a[i] = (a[i] as number) * 0.5 + (b[i] as number) * 0.25 + i;
          sum += a[i] as number;
        }
      expect(sum).toBeGreaterThan(0);
    });
    const ms = cpu(() => stampStrips({ goal: 20, art, base }));
    expect(ms).toBeLessThan(8000 * Math.max(1, reference / 250));
  });
});

describe('compositor memory', () => {
  it('holds at most 48 MB of mips and patches for 4 x 1000 px art at goal 20', {
    timeout: 180_000,
  }, () => {
    const big = (v: number): Rgba => {
      const data = new Uint8Array(1000 * 1000 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([v, 255 - v, (i >> 8) & 255, 200], i);
      return { width: 1000, height: 1000, data };
    };
    const arts: StampArt = {
      filled: big(10),
      empty: big(60),
      reward: big(110),
      rewardEarned: big(160),
    };
    compositorMemory.live = 0;
    compositorMemory.peak = 0;
    const strips = stampStrips({ goal: 20, art: arts, base: {} });
    expect(strips).toHaveLength(42);
    expect(compositorMemory.peak).toBeGreaterThan(0);
    expect(compositorMemory.peak).toBeLessThan(48_000_000);
    expect(compositorMemory.live).toBe(0);
  });
});

const GOLDEN_G10_C7: string[] = [
  'b107e9144d815e7fb69d50530bb37064c84cd1c5',
  '5666dcd77637d3f74e12ad03234c9da6d4025471',
];
