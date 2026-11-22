import { describe, expect, it } from 'vitest';
import { entryLabel } from './entry-label.ts';

describe('entryLabel', () => {
  it('names the mode a release went to', () => {
    expect(entryLabel({ action: 'template.release', detail: { mode: 'live' } })).toBe(
      'Template version released to Live',
    );
    expect(entryLabel({ action: 'template.release', detail: { mode: 'test' } })).toBe(
      'Template version released to Test',
    );
  });

  it('keeps the plain label when the detail has no mode or the action has none', () => {
    expect(entryLabel({ action: 'template.release', detail: null })).toBe(
      'Template version released',
    );
    expect(entryLabel({ action: 'template.approve', detail: { mode: 'live' } })).toBe(
      'Template version approved',
    );
  });
});
