import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buddyPath, EMAIL_BUDDY, EMAIL_MOODS } from '../src/worker/email/buddy.ts';
import { decodePng } from './lib/png.ts';

const root = resolve(import.meta.dirname, '..');

// Regenerate with `node tools/build-email-art.ts` when these fail after an art or size change.
describe('public/email buddy PNGs', () => {
  for (const mood of EMAIL_MOODS)
    for (const density of [2, 3] as const) {
      const path = buddyPath(mood, density);
      it(`${path} matches the email box at ${density}x, small and transparent`, () => {
        const file = readFileSync(resolve(root, `public${path}`));
        expect(file.length).toBeLessThan(15_000);
        const img = decodePng(file);
        const alpha = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
        expect([img.width, img.height]).toEqual([
          EMAIL_BUDDY.width * density,
          EMAIL_BUDDY.height * density,
        ]);
        expect(EMAIL_BUDDY.crop.width * EMAIL_BUDDY.scale).toBeCloseTo(EMAIL_BUDDY.width);
        expect(EMAIL_BUDDY.crop.height * EMAIL_BUDDY.scale).toBeCloseTo(EMAIL_BUDDY.height);
        // Top corners are clear; the pocket's base runs along the bottom edge.
        expect(alpha(0, 0)).toBe(0);
        expect(alpha(img.width - 1, 0)).toBe(0);
        expect(alpha(img.width / 2, img.height - 1)).toBeGreaterThan(200);
      });
    }
});
