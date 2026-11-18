import { describe, expect, it } from 'vitest';
import {
  CreateScanningSessionSchema,
  UpdateScanningDeviceSchema,
  UpdateScanningSessionSchema,
} from './scanning-sessions.ts';

describe('scanning update schemas have no defaults', () => {
  it('a name-only device edit names nothing else', () => {
    expect(UpdateScanningDeviceSchema.parse({ name: 'Front door' })).toEqual({
      name: 'Front door',
    });
  });

  it('a name-only session edit keeps its scope and settings', () => {
    expect(UpdateScanningSessionSchema.parse({ name: 'Gala' })).toEqual({ name: 'Gala' });
    expect(UpdateScanningSessionSchema.parse({ accepts: null })).toEqual({ accepts: null });
  });

  it('takes customer settings and zones, each optional', () => {
    expect(
      UpdateScanningSessionSchema.parse({
        settings: { customer: { welcome: 'Hi there', greet: false } },
        zoneIds: ['z1'],
      }),
    ).toEqual({ settings: { customer: { welcome: 'Hi there', greet: false } }, zoneIds: ['z1'] });
    expect(UpdateScanningSessionSchema.parse({ zoneIds: [] })).toEqual({ zoneIds: [] });
    const bad = [
      { zoneIds: ['a', 'a'] },
      { zoneIds: Array.from({ length: 9 }, (_, i) => `z${i}`) },
      { settings: { customer: { welcome: 'x'.repeat(41) } } },
      { settings: { customer: { reason: 'show' } } },
    ];
    for (const body of bad) expect(UpdateScanningSessionSchema.safeParse(body).success).toBe(false);
    expect(
      CreateScanningSessionSchema.parse({ orgId: 'o', name: 'Gym', timeZone: 'UTC' }).zoneIds,
    ).toBeUndefined();
  });
});
