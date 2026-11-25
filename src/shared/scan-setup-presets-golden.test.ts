import { describe, expect, it } from 'vitest';
import { ScanSetupIntentSchema } from './contracts/scan-setup-intent.ts';
import golden from './golden/scan-setup-presets-planner.json';
import { planScanSetup } from './scan-setup-plan.ts';
import { applyPreset } from './scan-setup-plan-presets.ts';
import { ctxOf, ORG } from './scan-setup-plan-test-fixtures.ts';

const PRESETS = ['front_desk', 'event_night', 'venue', undefined] as const;
const DOORS: Record<string, unknown>[] = [
  {},
  { hours: 'always' },
  { hours: { every: ['10:00-12:00'] } },
  { scanners: { by: 'anyone', as: 'desk' } },
  { scanners: { by: 'staff' } },
  { devices: [{ layout: 'operator' }] },
  { devices: [{ layout: 'phone' }, { layout: 'phone', reader: 'barcode' }] },
  {
    devices: [
      { layout: 'phone', direction: 'in' },
      { layout: 'phone', direction: 'out' },
    ],
  },
  { more: { lookup: false } },
  { more: { checkIn: { mode: 'single' } } },
  { more: { offline: false } },
  { place: 'p1' },
  { place: 'zone_gym' },
  { admits: { templateIds: [], events: ['event_gala'] } },
  { admits: { templateIds: [], events: ['ev1'] } },
];

/**
 * The three original presets, and no preset, against what origin/main produced for 60 intents
 * (applied intent and plan). A change to one of them fails here.
 */
describe('original presets: golden', () => {
  it('applies and plans exactly as before', () => {
    const out: unknown[] = [];
    for (const preset of PRESETS)
      for (const d of DOORS) {
        const raw = {
          orgId: ORG,
          ...(preset ? { preset } : {}),
          places: [{ ref: 'p1', name: 'Inside', count: true }],
          events: [
            {
              ref: 'ev1',
              name: 'Show',
              templateIds: ['tpl_ticket'],
              reentry: true,
              opensAt: 1780000000000,
              closesAt: 1780020000000,
            },
          ],
          staff: [{ name: 'Ana', role: 'desk' }],
          doors: [{ name: 'Door', admits: { templateIds: ['tpl_day'] }, ...d }],
        };
        const parsed = ScanSetupIntentSchema.parse(raw);
        out.push({
          preset,
          d,
          applied: applyPreset(parsed),
          plan: planScanSetup(parsed, ctxOf()),
        });
      }
    expect(JSON.parse(JSON.stringify(out))).toEqual(golden);
  });
});
