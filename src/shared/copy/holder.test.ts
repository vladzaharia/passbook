import { describe, expect, it } from 'vitest';
import { HOLDER_COPY } from './holder.ts';

describe('holder copy counts', () => {
  it('adds all in the singular and plural', () => {
    expect(HOLDER_COPY.addAllCount(1)).toBe('Add 1 pass');
    expect(HOLDER_COPY.addAllCount(2)).toBe('Add 2 passes');
  });
});
