import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUDDY_SLICES,
  buddyPath,
  EMAIL_BADGE,
  EMAIL_BUDDY,
  EMAIL_MOODS,
  EMAIL_SCHEMES,
  sliceHeight,
} from '../src/shared/email-art.ts';
import { decodePng } from './lib/png.ts';

const root = resolve(import.meta.dirname, '..');

// Regenerate with `node tools/build-email-art.ts` when these fail after an art or size change.
describe('public/email buddy PNGs', () => {
  const expected = new Set<string>();
  for (const mood of EMAIL_MOODS)
    for (const scheme of EMAIL_SCHEMES)
      for (const slice of BUDDY_SLICES)
        for (const density of [2, 3] as const) {
          const path = buddyPath(mood, scheme, slice, density);
          expected.add(path.slice('/email/'.length));
          it(`${path} is the ${slice} slice at ${density}x, small and transparent`, () => {
            const file = readFileSync(resolve(root, `public${path}`));
            expect(file.length).toBeLessThan(10_000);
            const img = decodePng(file);
            const alpha = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3] ?? 0;
            expect([img.width, img.height]).toEqual([
              EMAIL_BUDDY.width * density,
              sliceHeight(slice) * density,
            ]);
            // Clear corners; ink on the seam row (the pocket's base, then the legs below it).
            expect(alpha(0, 0)).toBe(0);
            expect(alpha(img.width - 1, img.height - 1)).toBe(0);
            const row = slice === 'top' ? img.height - 2 * density : density;
            const ink = Array.from({ length: img.width }, (_, x) => alpha(x, row)).filter(
              (a) => a > 200,
            );
            expect(ink.length).toBeGreaterThan(0);
          });
        }

  it('ships exactly these files, none named with @', () => {
    expect(new Set(readdirSync(resolve(root, 'public/email')))).toEqual(expected);
  });
});

// Apple's kit, when it lands, may change the art's aspect: the email's fixed box must follow.
describe('the email badge box', () => {
  it("keeps the PNG's aspect at its 44 px height", () => {
    const img = decodePng(readFileSync(resolve(root, `public${EMAIL_BADGE.path}`)));
    expect(EMAIL_BADGE.height).toBe(44);
    expect(
      Math.abs((EMAIL_BADGE.height * img.width) / img.height - EMAIL_BADGE.width),
    ).toBeLessThan(0.5);
  });
});
