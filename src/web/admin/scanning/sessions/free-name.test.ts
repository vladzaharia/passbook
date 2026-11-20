import { describe, expect, it } from 'vitest';
import { freeName } from './add-device-dialog.tsx';

describe('freeName', () => {
  it('is the name itself when it is free, then numbers it', () => {
    expect(freeName('Front door scanner', [])).toBe('Front door scanner');
    expect(freeName('Front door scanner', ['front door scanner'])).toBe('Front door scanner 2');
    expect(freeName('Front door scanner', ['Front door scanner', 'Front door scanner 2'])).toBe(
      'Front door scanner 3',
    );
  });

  it('keeps a long name inside 40 characters', () => {
    const base = 'A very long template name for a door scanner';
    const name = freeName(base, [base.slice(0, 40)]);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith(' 2')).toBe(true);
  });
});
