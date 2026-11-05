import { describe, expect, it } from 'vitest';
import { caretX, lookAt } from './gaze.ts';

describe('lookAt', () => {
  it('is -1…1 across the reach either side of the centre', () => {
    const scene = { left: 100, width: 200 };
    expect(lookAt(200, scene)).toBe(0);
    expect(lookAt(120, scene)).toBeCloseTo(-0.5);
    expect(lookAt(-900, scene)).toBe(-1);
    expect(lookAt(900, scene)).toBe(1);
  });
});

describe('caretX', () => {
  it('follows the characters and stops at the field edge', () => {
    const field = { getBoundingClientRect: () => ({ left: 10, right: 310 }) } as HTMLInputElement;
    expect(caretX(field, 0)).toBe(22);
    expect(caretX(field, 10)).toBeCloseTo(22 + 83);
    expect(caretX(field, 500)).toBe(298);
  });
});
