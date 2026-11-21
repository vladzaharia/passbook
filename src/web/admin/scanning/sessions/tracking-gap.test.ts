import { describe, expect, it } from 'vitest';
import { trackingGap } from './draft.ts';

const draft = (patch: object = {}) =>
  ({ direction: 'pass', checkIn: {}, eventIds: [], ...patch }) as Parameters<typeof trackingGap>[0];
const events = [
  { id: 'e1', reentry: true },
  { id: 'e2', reentry: false },
];

describe('trackingGap', () => {
  it('names a Both or Out direction that does not track', () => {
    expect(trackingGap(draft({ direction: 'both' }), [])).toBe('Direction Both');
    expect(trackingGap(draft({ direction: 'out', checkIn: { mode: 'daily' } }), [])).toBe(
      'Direction Out',
    );
  });

  it('names a re-entry event that does not track', () => {
    expect(trackingGap(draft({ eventIds: ['e1'] }), events)).toBe('Re-entry');
    expect(trackingGap(draft({ eventIds: ['e2'] }), events)).toBeNull();
  });

  it('is quiet once the session tracks in / out, and for In', () => {
    expect(
      trackingGap(
        draft({ direction: 'both', checkIn: { mode: 'in_out' }, eventIds: ['e1'] }),
        events,
      ),
    ).toBeNull();
    expect(trackingGap(draft({ direction: 'in' }), [])).toBeNull();
  });
});
