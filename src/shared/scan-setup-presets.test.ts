import { describe, expect, it } from 'vitest';
import { ScanSetupIntentSchema } from './contracts/scan-setup-intent.ts';
import { applyPreset } from './scan-setup-plan-presets.ts';
import { codes, ORG, planned } from './scan-setup-plan-test-fixtures.ts';
import { SCAN_SETUP_PRESET_IDS } from './scan-setup-preset-ids.ts';

const filled = (preset: string, door: Record<string, unknown> = {}) => {
  const intent = ScanSetupIntentSchema.parse({
    orgId: ORG,
    preset,
    doors: [{ name: 'Door', admits: { any: true }, ...door }],
  });
  return applyPreset(intent).doors[0];
};

describe('applyPreset: the new presets fill exactly', () => {
  it('club: anyone as Door, an in phone and an out phone, in and out', () => {
    expect(filled('club')).toMatchObject({
      scanners: { by: 'anyone', as: 'door' },
      devices: [
        { layout: 'phone', direction: 'in' },
        { layout: 'phone', direction: 'out' },
      ],
      more: { checkIn: { mode: 'in_out' } },
    });
    expect(filled('club')?.hours).toBeUndefined();
  });

  it('conference: staff PIN, a badge tablet and a second badge lane, once a day, 08:00-18:00', () => {
    expect(filled('conference')).toMatchObject({
      scanners: { by: 'staff' },
      devices: [{ layout: 'operator' }, { layout: 'phone' }],
      hours: { every: ['08:00-18:00'] },
      more: { checkIn: { mode: 'daily' }, lookup: true, showPhoto: true, deskActions: true },
    });
  });

  it('gates: three devices with a barcode reader, one entry each', () => {
    expect(filled('gates')).toMatchObject({
      scanners: { by: 'anyone', as: 'door' },
      devices: [{ layout: 'phone' }, { layout: 'phone' }, { layout: 'phone', reader: 'barcode' }],
      more: { checkIn: { mode: 'single' } },
    });
  });

  it('counter: a tablet and a customer screen, unlimited, the operator chooses', () => {
    expect(filled('counter')).toMatchObject({
      scanners: { by: 'staff' },
      devices: [{ layout: 'operator' }, { layout: 'customer' }],
      more: {
        checkIn: { mode: 'unlimited' },
        flow: 'choose',
        lookup: true,
        deskActions: true,
        customer: { greet: true, showReady: true },
      },
    });
  });

  it('pickup: staff PIN, one tablet, one pickup per pass', () => {
    expect(filled('pickup')).toMatchObject({
      scanners: { by: 'staff' },
      devices: [{ layout: 'operator' }],
      more: { checkIn: { mode: 'single' }, lookup: true, deskActions: true },
    });
  });

  it('capacity: an in phone and an out phone, 09:00-17:00, a hard limit', () => {
    expect(filled('capacity')).toMatchObject({
      scanners: { by: 'anyone', as: 'door' },
      devices: [
        { layout: 'phone', direction: 'in' },
        { layout: 'phone', direction: 'out' },
      ],
      hours: { every: ['09:00-17:00'] },
      more: { checkIn: { mode: 'in_out' }, hardLimit: true },
    });
  });

  it('keeps what the door sets, hours always included', () => {
    const door = filled('conference', {
      hours: 'always',
      scanners: { by: 'anyone', as: 'desk' },
      more: { checkIn: { mode: 'single' }, lookup: false },
    });
    expect(door).toMatchObject({
      hours: 'always',
      scanners: { by: 'anyone', as: 'desk' },
      more: { checkIn: { mode: 'single' }, lookup: false, deskActions: true },
    });
  });

  it('venue and event night keep their behaviour: nothing else is filled', () => {
    expect(filled('venue')).toEqual({ name: 'Door', admits: { any: true } });
    expect(filled('event_night')).toMatchObject({ scanners: { by: 'anyone', as: 'door' } });
  });

  it('every preset plans', () => {
    for (const preset of SCAN_SETUP_PRESET_IDS) {
      const plan = planned({
        preset,
        places: [{ ref: 'p1', name: 'Inside', max: 40 }],
        doors: [{ name: 'Door', place: 'p1', admits: { templateIds: ['tpl_day'] } }],
      });
      expect(plan.sessions).toHaveLength(1);
    }
  });
});

describe('planned sessions of the new presets', () => {
  const door = { name: 'Door', admits: { templateIds: ['tpl_day'] } };
  it('gates: the offline list, a barcode reader on the third device', () => {
    const [s] = planned({ preset: 'gates', doors: [door] }).sessions;
    expect(s?.settings).toMatchObject({
      checkIn: { mode: 'single' },
      offline: true,
      whenOffline: 'list',
    });
    expect(s?.devices.map((d) => d.overrides)).toEqual([{}, {}, { reader: 'barcode' }]);
  });
  it('counter: operator and customer screen, staff sign in', () => {
    const [s] = planned({ preset: 'counter', doors: [door] }).sessions;
    expect(s?.devices.map((d) => d.surface)).toEqual(['operator', 'customer']);
    expect(s?.settings).toMatchObject({ staffSignIn: true, flow: 'choose' });
  });
  const place = { ref: 'galleries', name: 'Galleries', count: true };
  it('capacity: hours on the session, in and out phones, a hard limit', () => {
    const plan = planned({
      preset: 'capacity',
      places: [{ ...place, max: 40 }],
      doors: [{ ...door, place: 'galleries' }],
    });
    const [s] = plan.sessions;
    expect(s?.hours).toMatchObject({ mon: ['09:00-17:00'], sun: ['09:00-17:00'] });
    expect(s?.settings).toMatchObject({
      hardLimit: true,
      direction: 'both',
      checkIn: { mode: 'in_out' },
    });
    expect(s?.devices.map((d) => d.overrides)).toEqual([{ direction: 'in' }, { direction: 'out' }]);
  });
  it('capacity: a hard limit with no max is refused', () => {
    const none = codes({
      preset: 'capacity',
      places: [place],
      doors: [{ ...door, place: 'galleries' }],
    });
    expect(none).toContain('SETUP_HARD_LIMIT_NO_CAPACITY');
    expect(codes({ preset: 'capacity', doors: [door] })).toContain('SETUP_HARD_LIMIT_NO_CAPACITY');
    expect(
      codes({
        preset: 'capacity',
        places: [{ ...place, max: 40 }],
        doors: [{ ...door, place: 'galleries' }],
      }),
    ).toEqual([]);
  });
});
