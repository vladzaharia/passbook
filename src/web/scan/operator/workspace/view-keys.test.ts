import { describe, expect, it } from 'vitest';
import { shortcutsFor } from './help-sheet.tsx';
import { hintsOf } from './hints.ts';

describe('list-switch keys', () => {
  it('read the same on the sheet and the status bar', () => {
    for (const views of [2, 3]) {
      const sheet = shortcutsFor({ record: false, rollCall: false, views, walkIn: false }).find(
        (row) => row.id === 'views',
      );
      const bar = hintsOf({ searching: false, record: false, undoable: false, views }).find(
        (h) => h.label === 'Lists',
      );
      expect(sheet?.keys).toEqual([bar?.keys]);
      expect(bar?.keys).toBe(`⌥1-${views}`);
    }
  });
});
