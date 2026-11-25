import { describe, expect, it } from 'vitest';
import { inZone, storable } from './files-values.ts';

describe('zone-less datetimes', () => {
  it('reads wall time in the zone on either side of a DST change', () => {
    expect(inZone('2026-03-08T01:30:00', 'America/Los_Angeles')).toBe('2026-03-08T01:30:00-08:00');
    expect(inZone('2026-03-08T03:30:00', 'America/Los_Angeles')).toBe('2026-03-08T03:30:00-07:00');
    expect(inZone('2026-11-01T12:00:00', 'America/Los_Angeles')).toBe('2026-11-01T12:00:00-08:00');
    expect(inZone('2026-07-01T12:00:00', 'Asia/Kolkata')).toBe('2026-07-01T12:00:00+05:30');
  });

  it('leaves dates, offsets and other text alone', () => {
    for (const v of ['2026-07-01', '2026-07-01T09:30:00Z', '2026-07-01T09:30:00+02:00', 'hello'])
      expect(inZone(v, 'America/Los_Angeles')).toBe(v);
  });

  it('converts 100,000 datetimes well inside the CPU budget', () => {
    const start = Date.UTC(2026, 0, 1);
    const rows = Array.from({ length: 100_000 }, (_, i) => {
      const d = new Date(start + i * 5 * 60_000);
      return d.toISOString().slice(0, 19);
    });
    const t = performance.now();
    const out = rows.map((v) => storable(v, 'America/Los_Angeles') as string);
    const ms = performance.now() - t;
    expect(out.every((v) => /[+-]0[78]:00$/.test(v))).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});
