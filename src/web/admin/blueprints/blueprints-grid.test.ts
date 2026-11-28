import { describe, expect, it } from 'vitest';
import { gridFor } from './blueprints-page.tsx';

const cols = (count: number, prefix: string) =>
  Number(new RegExp(`${prefix}:grid-cols-(\\d)`).exec(gridFor(count))?.[1] ?? 2);

describe('gridFor', () => {
  it('never loses columns as the screen grows, and keeps tiles in one row when few', () => {
    for (let n = 1; n <= 12; n++) {
      const [mobile, md, xl] = [2, cols(n, 'md'), cols(n, 'xl')];
      expect(md, `${n} at md`).toBeGreaterThanOrEqual(mobile);
      expect(xl, `${n} at xl`).toBeGreaterThanOrEqual(md);
      if (n <= 3) expect(md).toBe(Math.max(n, 2));
      if (n <= 4) expect(xl).toBe(Math.max(n, 2));
    }
  });

  it('fills rows where a count allows it', () => {
    expect(cols(12, 'xl')).toBe(4);
    expect(cols(12, 'md')).toBe(3);
    expect(cols(4, 'md')).toBe(2);
    expect(cols(6, 'xl')).toBe(3);
  });
});
