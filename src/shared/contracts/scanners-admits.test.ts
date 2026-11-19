import { describe, expect, it } from 'vitest';
import { AdmitsSchema, admitsOf, admitsWire, ScannerAcceptsSchema } from './scanners.ts';
import { CreateScanningSessionSchema } from './scanning-sessions.ts';

const E1 = '01900000-0000-7000-8000-000000000001';
const E2 = '01900000-0000-7000-8000-000000000002';
const T1 = '01900000-0000-7000-8000-000000000011';

describe('Admits', () => {
  it('parses the legacy one-event and template forms as lists', () => {
    expect(admitsOf(AdmitsSchema.parse({ eventId: E1 }))).toEqual({
      templateIds: [],
      eventIds: [E1],
    });
    expect(admitsOf(AdmitsSchema.parse({ templateIds: [T1, T1] }))).toEqual({
      templateIds: [T1],
      eventIds: [],
    });
  });

  it('takes events and templates together, up to the caps', () => {
    const mixed = { templateIds: [T1], eventIds: [E1, E2] };
    expect(admitsOf(AdmitsSchema.parse(mixed))).toEqual(mixed);
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `01900000-0000-7000-8000-${String(i).padStart(12, '0')}`);
    expect(AdmitsSchema.safeParse({ templateIds: ids(100), eventIds: [] }).success).toBe(true);
    expect(AdmitsSchema.safeParse({ templateIds: ids(101), eventIds: [] }).success).toBe(false);
    expect(AdmitsSchema.safeParse({ templateIds: [], eventIds: ids(11) }).success).toBe(false);
  });

  it('refuses an empty or unknown shape', () => {
    expect(AdmitsSchema.safeParse({ templateIds: [], eventIds: [] }).success).toBe(false);
    expect(AdmitsSchema.safeParse({ templateIds: [T1], eventIds: [], extra: 1 }).success).toBe(
      false,
    );
    expect(AdmitsSchema.safeParse({}).success).toBe(false);
  });

  it('shows a single shape in the older form and a mix as lists', () => {
    expect(admitsWire({ templateIds: [], eventIds: [E1] })).toEqual({ eventId: E1 });
    expect(admitsWire({ templateIds: [T1], eventIds: [] })).toEqual({ templateIds: [T1] });
    expect(admitsWire({ templateIds: [T1], eventIds: [E1] })).toEqual({
      templateIds: [T1],
      eventIds: [E1],
    });
  });

  it('lets a session mix and keeps a scanner row to one shape of up to 100 templates', () => {
    expect(ScannerAcceptsSchema.safeParse({ templateIds: [T1] }).success).toBe(true);
    expect(ScannerAcceptsSchema.safeParse({ templateIds: [] }).success).toBe(false);
    const body = { orgId: E1, name: 'Door', timeZone: 'UTC' };
    expect(
      CreateScanningSessionSchema.parse({ ...body, accepts: { templateIds: [T1], eventIds: [E2] } })
        .accepts,
    ).toEqual({ templateIds: [T1], eventIds: [E2] });
  });
});
