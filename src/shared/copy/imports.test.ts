import { describe, expect, it } from 'vitest';
import { IMPORT_COPY } from './imports.ts';

describe('the Check button label', () => {
  it('says "row" for one row', () => {
    expect(IMPORT_COPY.match.checkRows(1)).toBe('Check 1 row');
  });

  it('says "rows" for any other count', () => {
    expect(IMPORT_COPY.match.checkRows(40)).toBe('Check 40 rows');
  });

  it('has no count until the rows are read', () => {
    expect(IMPORT_COPY.match.checkRows(null)).toBe('Check');
  });
});
