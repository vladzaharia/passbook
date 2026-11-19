import { describe, expect, it } from 'vitest';
import { normalize } from '../../../shared/pass-view/index.ts';
import { hideEmpty } from './preview.ts';

describe('join preview', () => {
  it('leaves out a field with no value, in every layout', () => {
    const view = normalize(
      {
        formatVersion: 1,
        passTypeIdentifier: 'pass.test',
        serialNumber: 's',
        teamIdentifier: 't',
        organizationName: 'Dos Olas',
        description: 'Card',
        generic: {
          primaryFields: [{ key: 'holder', label: 'Name', value: '' }],
          secondaryFields: [{ key: 'tier', label: 'Tier', value: 'Plus' }],
        },
      },
      { assets: {}, now: new Date('2026-10-31T12:00:00Z'), timeZone: 'UTC' },
    );
    const shown = hideEmpty(view);
    expect(shown.layout.primary).toEqual([]);
    expect(shown.layout.secondary.map((f) => f.label)).toEqual(['Tier']);
    for (const layout of Object.values(shown.layouts)) expect(layout.primary).toEqual([]);
  });
});
