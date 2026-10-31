import { describe, expect, it } from 'vitest';
import { importErrorMessage } from './templates.ts';

describe('importErrorMessage', () => {
  it('maps codes to sentences and never shows a raw code', () => {
    expect(importErrorMessage(null)).toBeNull();
    expect(importErrorMessage('IMPORT_INVALID')).toBe(
      'The package has errors. Fix them and upload again.',
    );
    expect(importErrorMessage('SOMETHING_NEW')).not.toContain('SOMETHING_NEW');
  });
});
