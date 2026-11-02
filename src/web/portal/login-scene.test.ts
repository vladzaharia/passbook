import { describe, expect, it } from 'vitest';
import { lookAt } from './login-scene.tsx';

describe('lookAt', () => {
  const wallet = { left: 779, width: 128 };

  it('is 0 under the wallet and turns fully 160 px to either side', () => {
    expect(lookAt(843, wallet)).toBe(0);
    expect(lookAt(763, wallet)).toBeCloseTo(-0.5);
    expect(lookAt(603, wallet)).toBe(-1);
    expect(lookAt(1003, wallet)).toBe(1);
  });

  it('holds at the extremes', () => {
    expect(lookAt(0, wallet)).toBe(-1);
    expect(lookAt(4000, wallet)).toBe(1);
  });
});
