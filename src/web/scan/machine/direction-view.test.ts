import { describe, expect, it } from 'vitest';
import { nextDirection, shownDirection } from './direction-view.ts';

describe('which way a scanner reads', () => {
  it('a fixed scanner reads its setting, whatever the pin', () => {
    expect(shownDirection('in', 'out', 'in')).toBe('in');
    expect(shownDirection('out', null, 'in')).toBe('out');
  });
  it('a Both scanner reads the pin, then the scope, else Auto', () => {
    expect(shownDirection('both', 'in', 'out')).toBe('in');
    expect(shownDirection('both', null, 'out')).toBe('out');
    expect(shownDirection('both', null, 'in')).toBe('auto');
  });
  it('one tap goes Auto, In, Out and round again', () => {
    expect(nextDirection('auto')).toBe('in');
    expect(nextDirection('in')).toBe('out');
    expect(nextDirection('out')).toBeNull();
  });
  it('a session scoped Out goes Out, In and back: Out is not a dead stop', () => {
    expect(shownDirection('both', null, 'out')).toBe('out');
    expect(nextDirection('out', 'out')).toBe('in');
    expect(shownDirection('both', 'in', 'out')).toBe('in');
    expect(nextDirection('in', 'out')).toBeNull();
  });
});
