import { describe, expect, it } from 'vitest';
import { INITIAL, stateOfBroadcast, targetOf } from './composer-state.ts';
import { broadcast } from './test-fixtures.ts';

describe('message scan audiences', () => {
  it('requires an event before producing an event-filtered target', () => {
    const state = { ...INITIAL, templateIds: ['template'], scanKind: 'checkedIn' as const };
    expect(targetOf(state)).toBeUndefined();
    expect(targetOf({ ...state, scanEventId: 'event' })).toMatchObject({
      scan: { eventId: 'event', checkedIn: true },
    });
    expect(targetOf({ ...state, scanKind: 'notCheckedIn', scanEventId: 'event' })).toMatchObject({
      scan: { eventId: 'event', checkedIn: false },
    });
  });

  it('round trips scan filters when editing a draft', () => {
    for (const scan of [{ eventId: 'event', checkedIn: false }, { noScanDays: 90 as const }]) {
      const draft = broadcast({ state: 'draft', target: { templateIds: ['template'], scan } });
      expect(targetOf(stateOfBroadcast(draft))?.scan).toEqual(scan);
    }
  });
});
