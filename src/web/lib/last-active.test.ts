import { describe, expect, it } from 'vitest';
import { formatLastActive } from './format.ts';

const NOW = new Date(2026, 10, 18, 15, 30).getTime();

describe('formatLastActive', () => {
  it('reads as one short phrase', () => {
    expect(formatLastActive(NOW - 60_000, NOW)).toBe('Active now');
    expect(formatLastActive(new Date(2026, 10, 18, 9, 5).getTime(), NOW)).toMatch(/^Today /);
    expect(formatLastActive(new Date(2026, 10, 17, 22, 0).getTime(), NOW)).toBe('Yesterday');
    expect(formatLastActive(new Date(2026, 10, 1, 12, 0).getTime(), NOW)).toBe('Active Nov 1');
  });
});
