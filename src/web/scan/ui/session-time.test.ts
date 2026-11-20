import { afterEach, expect, it } from 'vitest';
import { formatTime } from '../../lib/format.ts';
import { sessionTime, setSessionZone } from './session-time.ts';

afterEach(() => setSessionZone(null));

const AT = Date.UTC(2026, 10, 19, 4, 38);

it('reads on the device clock without a session zone', () => {
  expect(sessionTime(AT)).toBe(formatTime(AT));
});

it('shows the session zone, labelled when it differs from the device', () => {
  setSessionZone('Pacific/Kiritimati');
  const shown = sessionTime(AT);
  expect(shown).toBe(`${formatTime(AT, 'Pacific/Kiritimati')} GMT+14`);
});

it('leaves the label off when the zone matches the device', () => {
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  setSessionZone(device);
  expect(sessionTime(AT)).toBe(formatTime(AT));
});
