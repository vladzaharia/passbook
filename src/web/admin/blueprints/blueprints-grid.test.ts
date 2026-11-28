import { describe, expect, it } from 'vitest';
import { gridFor } from './blueprints-page.tsx';

describe('gridFor', () => {
  it('fills every row at each width', () => {
    expect(gridFor(12)).toContain('md:grid-cols-4');
    expect(gridFor(3)).toContain('md:grid-cols-3');
    expect(gridFor(3)).toContain('lg:grid-cols-3');
    expect(gridFor(6)).toContain('lg:grid-cols-3');
    expect(gridFor(6)).toContain('md:grid-cols-3');
  });
});
