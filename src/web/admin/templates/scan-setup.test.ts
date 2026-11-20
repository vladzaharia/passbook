import { describe, expect, it } from 'vitest';
import { scanSetupSummary } from './scan-setup.ts';

const session = { id: 's1', name: 'Front door' };
const events = (n: number, created = true) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}`, name: `Night ${i + 1}`, created }));

describe('scanSetupSummary', () => {
  it('names the event and session it made', () => {
    expect(
      scanSetupSummary({
        session,
        created: true,
        events: [{ id: 'e1', name: 'Harbour Lights: Night Two', created: true }],
        noEvents: false,
      }),
    ).toBe('Created event Harbour Lights: Night Two and session Front door. Edit anything here.');
  });

  it('says only the session for a door template', () => {
    expect(scanSetupSummary({ session, created: true, events: [], noEvents: false })).toBe(
      'Created session Front door. Edit anything here.',
    );
  });

  it('says so when no event was made because no pass names one', () => {
    expect(scanSetupSummary({ session, created: true, events: [], noEvents: true })).toBe(
      'Created session Front door. No event yet: no passes with an upcoming event are issued. Edit anything here.',
    );
  });

  it('lists a few events and counts many', () => {
    expect(scanSetupSummary({ session, created: true, events: events(2), noEvents: false })).toBe(
      'Created events Night 1 and Night 2 and session Front door. Edit anything here.',
    );
    expect(scanSetupSummary({ session, created: true, events: events(5), noEvents: false })).toBe(
      'Created 5 events and session Front door. Edit anything here.',
    );
  });

  it('says what a repeat call added, or that nothing changed', () => {
    expect(
      scanSetupSummary({ session, created: false, events: events(1, false), noEvents: false }),
    ).toBe('Added event Night 1 to session Front door. Edit anything here.');
    expect(scanSetupSummary({ session, created: false, events: [], noEvents: false })).toBe(
      'Front door already scans these passes. Edit anything here.',
    );
  });
});
