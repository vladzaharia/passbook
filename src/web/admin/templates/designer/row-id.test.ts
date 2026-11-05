import { describe, expect, it } from 'vitest';
import { rowId } from './row-id.ts';

describe('rowId', () => {
  it('is a valid view-transition-name for keys with odd characters', () => {
    for (const key of ['title', 'a b', 'x:y', 'é', '1', 'a.b/c', '"q"']) {
      const name = `row-${rowId('field', key)}`;
      expect(/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name), name).toBe(true);
    }
  });
  it('keeps distinct keys and kinds distinct', () => {
    expect(rowId('field', 'a b')).not.toBe(rowId('field', 'a_b'));
    expect(rowId('field', 'a')).not.toBe(rowId('input', 'a'));
  });
});
