import { describe, expect, it } from 'vitest';
import { SCAN_OCCUPANCY_COPY, SCAN_REASON_COPY } from './scan.ts';

describe('repeat-scan lines', () => {
  it('ask for ID on a repeat entry', () => {
    const lines = [
      SCAN_REASON_COPY.already_done,
      SCAN_REASON_COPY.still_inside,
      SCAN_OCCUPANCY_COPY.eventStillIn,
      SCAN_OCCUPANCY_COPY.stillInRecent,
    ];
    for (const line of lines) expect(line?.sub.endsWith('. Check ID.')).toBe(true);
  });
});
