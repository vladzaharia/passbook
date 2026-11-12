import { describe, expect, it } from 'vitest';
import { UpdateScanningDeviceSchema, UpdateScanningSessionSchema } from './scanning-sessions.ts';

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
});
