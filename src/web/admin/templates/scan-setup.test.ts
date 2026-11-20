import { describe, expect, it } from 'vitest';
import { scanSetupSummary } from './scan-setup.ts';

const session = { id: 's1', name: 'Front door' };
const events = (n: number, created = true) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}`, name: `Night ${i + 1}`, created }));
const base = { session, created: true, events: [], noEvents: false, truncated: false };

describe('scanSetupSummary', () => {
  it('names the event and session it made', () => {
    const one = [{ id: 'e1', name: 'Harbour Lights: Night Two', created: true }];
    expect(scanSetupSummary({ ...base, events: one })).toBe(
      'Created event Harbour Lights: Night Two and session Front door. Edit anything here.',
    );
  });

  it('says only the session for a door template', () => {
    expect(scanSetupSummary(base)).toBe('Created session Front door. Edit anything here.');
  });

  it('says so when no event was made because no pass names one', () => {
    expect(scanSetupSummary({ ...base, noEvents: true })).toBe(
      'Created session Front door. No event yet: no passes with an upcoming event are issued. Edit anything here.',
    );
  });

  it('lists a few events and counts many', () => {
    expect(scanSetupSummary({ ...base, events: events(2) })).toBe(
      'Created events Night 1 and Night 2 and session Front door. Edit anything here.',
    );
    expect(scanSetupSummary({ ...base, events: events(5) })).toBe(
      'Created 5 events and session Front door. Edit anything here.',
    );
  });

  it('says what a repeat call added, or that nothing changed', () => {
    expect(scanSetupSummary({ ...base, created: false, events: events(1, false) })).toBe(
      'Added event Night 1 to session Front door. Edit anything here.',
    );
    expect(scanSetupSummary({ ...base, created: false })).toBe(
      'Front door already scans these passes. Edit anything here.',
    );
  });

  it('says when an event was already there, and when more are coming up', () => {
    expect(scanSetupSummary({ ...base, events: events(1, false) })).toBe(
      'Created session Front door with event Night 1. Edit anything here.',
    );
    expect(scanSetupSummary({ ...base, created: false, truncated: true })).toBe(
      'Front door already scans these passes. More events are coming up; the soonest are here. Edit anything here.',
    );
  });
});
