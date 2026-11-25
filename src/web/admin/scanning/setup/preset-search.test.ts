import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { SCAN_SETUP_PRESET_IDS } from '@/shared/scan-setup-preset-ids.ts';
import { Route } from '../../../routes/admin/o/$orgId/scanning/setup.tsx';
import { isPreset, PRESETS, presetLabel } from './draft.ts';

const schema = Route.options.validateSearch as unknown as ZodType<{ preset?: string }>;
const parse = (search: unknown) => schema.parse(search);

describe('setup route search', () => {
  it('accepts all nine presets', () => {
    expect(SCAN_SETUP_PRESET_IDS).toHaveLength(9);
    for (const preset of SCAN_SETUP_PRESET_IDS) expect(parse({ preset }).preset).toBe(preset);
  });
  it('drops one it does not know', () => {
    expect(parse({ preset: 'spa' }).preset).toBeUndefined();
    expect(isPreset('spa')).toBe(false);
  });
  it('every preset has a tile label', () => {
    expect(PRESETS.map((p) => presetLabel(p))).toEqual([
      'Front desk',
      'Event night',
      'Several areas',
      'Club entry',
      'Conference',
      'Ticket gates',
      'Counter',
      'Pickup',
      'Capacity',
    ]);
  });
});
