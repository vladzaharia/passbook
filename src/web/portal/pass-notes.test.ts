import { describe, expect, it } from 'vitest';
import { noteRows } from './pass-fields.ts';

const pass = (backFields: unknown[]) => ({ generic: { backFields } });

describe('noteRows', () => {
  it('lists the message first, then the note; empty and other fields are skipped', () => {
    const rows = noteRows(
      pass([
        { key: 'note', label: 'Note', value: 'Upgraded.' },
        { key: 'terms', label: 'Terms', value: 'Present the barcode.' },
        { key: 'message', label: 'Message', value: '  Pool closed.  ' },
        { key: 'notes', label: 'NOTES', value: '' },
      ]),
    );
    expect(rows).toEqual([
      { id: 'message', label: 'Message', value: 'Pool closed.' },
      { id: 'note', label: 'Note', value: 'Upgraded.' },
    ]);
  });

  it('is empty without back fields or a style', () => {
    expect(noteRows({})).toEqual([]);
    expect(noteRows({ generic: {} })).toEqual([]);
  });
});
