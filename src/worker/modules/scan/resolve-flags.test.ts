import { describe, expect, it } from 'vitest';
import { createDisplayFixture, SCAN_CODE } from './display-split-fixture.ts';
import { activeFlags } from './resolve.ts';

const { fixture, inputOf } = createDisplayFixture();

describe('active flags for a scanner', () => {
  const flagged = () => {
    const found = fixture();
    found.scan.flags = [
      { input: 'seat', label: 'Seat hold' },
      { input: 'tier', label: 'Tier notice' },
      { input: 'tier', label: 'Dues unpaid', stop: true },
      { input: 'privateNotes', label: 'Hidden note', equals: ['x'] },
      { input: 'privateNotes', label: 'Private hold', stop: true },
    ];
    found.pass.personalization.privateNotes = 'x';
    return found;
  };

  it('names every flag when no actor is given', () => {
    expect(activeFlags(flagged()).map((flag) => flag.label)).toEqual([
      'Seat hold',
      'Tier notice',
      'Dues unpaid',
      'Hidden note',
      'Private hold',
    ]);
  });

  it('shows a hidden stop flag under one generic label and drops a hidden plain flag', () => {
    const found = flagged();
    expect(activeFlags(found, inputOf(found, 'door').actor)).toEqual([
      { label: 'Seat hold', stop: false },
      { label: 'Check required', stop: true },
    ]);
    // Positive control: a role that may read the sources sees the authored labels.
    expect(activeFlags(found, inputOf(found, 'desk').actor)).toEqual([
      { label: 'Seat hold', stop: false },
      { label: 'Tier notice', stop: false },
      { label: 'Dues unpaid', stop: true },
      { label: 'Check required', stop: true },
    ]);
  });

  it('uses the generic label for a stop flag whose label is a secret', () => {
    const found = fixture();
    found.scan.flags = [{ input: 'seat', label: SCAN_CODE, stop: true }];
    const flags = activeFlags(found, inputOf(found, 'manager').actor);
    expect(flags).toEqual([{ label: 'Check required', stop: true }]);
  });
});
