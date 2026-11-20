import { describe, expect, it } from 'vitest';
import { hasScanBlock, scanSetupSummary } from './scan-setup.ts';

const session = { id: 's1', name: 'Front door' };

describe('scanSetupSummary', () => {
  it('names the event and session it made', () => {
    expect(
      scanSetupSummary({
        session,
        created: true,
        events: [{ id: 'e1', name: 'Harbour Lights: Night Two', created: true }],
        undated: [],
      }),
    ).toBe('Created event Harbour Lights: Night Two and session Front door. Edit anything here.');
  });

  it('says only the session for a door template', () => {
    expect(scanSetupSummary({ session, created: true, events: [], undated: [] })).toBe(
      'Created session Front door. Edit anything here.',
    );
  });

  it('lists a few events and counts many, and flags an undated one', () => {
    const events = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `e${i}`, name: `Night ${i + 1}`, created: true }));
    expect(scanSetupSummary({ session, created: true, events: events(2), undated: [] })).toBe(
      'Created events Night 1 and Night 2 and session Front door. Edit anything here.',
    );
    expect(
      scanSetupSummary({ session, created: true, events: events(5), undated: ['Finale'] }),
    ).toBe('Created 5 events and session Front door. Finale has no date yet. Edit anything here.');
  });

  it('says so when a session already scans the passes', () => {
    expect(scanSetupSummary({ session, created: false, events: [], undated: [] })).toBe(
      'Front door already scans these passes. Edit anything here.',
    );
  });
});

describe('hasScanBlock', () => {
  it('is true only for a manifest with a scan block', () => {
    expect(hasScanBlock({ scan: { actions: [] } })).toBe(true);
    expect(hasScanBlock({ name: 'x' })).toBe(false);
    expect(hasScanBlock(null)).toBe(false);
  });
});
