import { describe, expect, it } from 'vitest';
import { ctxOf, planned } from './scan-setup-plan-test-fixtures.ts';

const gym = { ref: 'gym-floor', name: 'Gym floor', max: 60 };

describe('planScanSetup presets', () => {
  it('front desk: staff by PIN, an operator tablet and a phone, desk tools on, in and out', () => {
    const plan = planned({
      preset: 'front_desk',
      places: [gym],
      doors: [{ name: 'Front desk', place: 'gym-floor', admits: { templateIds: ['tpl_gym'] } }],
    });
    const [s] = plan.sessions;
    expect(plan.zones).toHaveLength(1);
    expect(s?.settings).toMatchObject({
      direction: 'both',
      staffSignIn: true,
      lookup: true,
      showPhoto: true,
      deskActions: true,
    });
    expect(s?.devices.map((d) => [d.name, d.surface, d.role])).toEqual([
      ['Front desk 1', 'operator', 'scan'],
      ['Front desk 2', 'auto', 'scan'],
    ]);
    expect(plan.checks.map((c) => c.code)).toContain('NO_STAFF');
  });

  it('front desk keeps what the door sets', () => {
    const plan = planned({
      preset: 'front_desk',
      staff: [{ name: 'Maya', role: 'manager' }],
      doors: [
        {
          name: 'Desk',
          admits: { any: true },
          scanners: { by: 'anyone', as: 'desk' },
          devices: [{ layout: 'phone' }],
          more: { lookup: false },
        },
      ],
    });
    const [s] = plan.sessions;
    expect(s?.settings).toMatchObject({
      lookup: false,
      staffSignIn: false,
      roleWithoutSignIn: 'desk',
    });
    expect(s?.devices).toHaveLength(1);
    expect(s?.accepts).toBeNull();
  });

  it('event night: one event, anyone scans as Door, the offline list, no direction', () => {
    const plan = planned({
      preset: 'event_night',
      events: [
        { ref: 'gala', name: 'Gala', templateIds: ['tpl_day'], opensAt: 1000, closesAt: 2000 },
      ],
      doors: [{ name: 'Doors', admits: { events: ['gala'] }, devices: [{}, {}] }],
    });
    const [s] = plan.sessions;
    expect(plan.events).toHaveLength(1);
    expect(s?.accepts).toEqual({ templateIds: [], events: [{ ref: 'gala' }] });
    expect(s?.hours).toBeNull();
    expect(s?.zones).toEqual([]);
    expect(s?.settings.direction).toBeUndefined();
    expect(s?.settings.checkIn).toBeUndefined();
    expect(s?.settings).toMatchObject({
      staffSignIn: false,
      roleWithoutSignIn: 'door',
      offline: true,
      whenOffline: 'list',
    });
    expect(s?.devices.map((d) => d.name)).toEqual(['Doors 1', 'Doors 2']);
  });

  it('event night: re-entry turns the doors to both; a box office signs staff in with lookup', () => {
    const plan = planned({
      preset: 'event_night',
      events: [
        {
          ref: 'gala',
          name: 'Gala',
          templateIds: ['tpl_day'],
          opensAt: 1000,
          closesAt: 2000,
          reentry: true,
          max: 300,
        },
      ],
      staff: [{ name: 'Sam', role: 'manager' }],
      doors: [
        { name: 'Doors', admits: { events: ['gala'] } },
        { name: 'Box office', admits: { events: ['gala'] }, devices: [{ layout: 'operator' }] },
      ],
    });
    const [doors, box] = plan.sessions;
    expect(plan.events[0]).toMatchObject({ capacity: 300, reentry: true });
    expect(doors?.settings.direction).toBe('both');
    expect(box?.settings).toMatchObject({ staffSignIn: true, lookup: true });
    expect(box?.settings.whenOffline).toBeUndefined();
  });

  it('several areas: the zone tree, one session per door, derived directions', () => {
    const plan = planned({
      preset: 'venue',
      places: [
        { ref: 'club', name: 'Club', count: true },
        { ref: 'pool', name: 'Pool', inside: 'club', max: 12 },
        { ref: 'sauna', name: 'Sauna', inside: 'club' },
      ],
      doors: [
        { name: 'Entrance', place: 'club', admits: { templateIds: ['tpl_gym'] } },
        { name: 'Pool', place: 'pool', admits: { templateIds: ['tpl_gym'] } },
        { name: 'Sauna', place: 'sauna', admits: { templateIds: ['tpl_gym'] } },
      ],
    });
    expect(plan.zones.map((z) => [z.key, z.parent, z.occupancy])).toEqual([
      ['club', null, 'track'],
      ['pool', { ref: 'club' }, 'track'],
      ['sauna', { ref: 'club' }, 'off'],
    ]);
    expect(plan.sessions.map((s) => s.settings.direction)).toEqual(['both', 'both', undefined]);
    expect(plan.sessions.map((s) => s.settings.checkIn?.mode)).toEqual([
      'in_out',
      'in_out',
      undefined,
    ]);
    expect(plan.sessions.map((s) => s.zones)).toEqual([
      [{ ref: 'club' }],
      [{ ref: 'pool' }],
      [{ ref: 'sauna' }],
    ]);
    const misses = plan.checks.filter((c) => c.code === 'PLAN_MISSES_PLACE');
    expect(misses).toHaveLength(3);
  });
});

describe('planScanSetup derived defaults', () => {
  const door = (over: Record<string, unknown> = {}) => ({
    name: 'Door',
    admits: { templateIds: ['tpl_day'] },
    ...over,
  });

  it('a counted place: phones both, a barcode reader in, and a check for an exit', () => {
    const plan = planned({
      places: [gym],
      doors: [door({ place: 'gym-floor', devices: [{ reader: 'barcode' }] })],
    });
    const [s] = plan.sessions;
    expect(s?.settings.direction).toBe('both');
    expect(s?.devices[0]?.overrides).toEqual({ reader: 'barcode', direction: 'in' });
    expect(plan.checks.find((c) => c.code === 'NO_EXIT')?.fix).toEqual({
      kind: 'add_device',
      session: 'door-1',
      direction: 'out',
    });
    const phone = planned({ places: [gym], doors: [door({ place: 'gym-floor' })] });
    expect(phone.sessions[0]?.devices[0]?.overrides).toEqual({});
    expect(phone.checks.map((c) => c.code)).not.toContain('NO_EXIT');
  });

  it('a re-entry event: both', () => {
    const plan = planned({
      events: [
        {
          ref: 'gala',
          name: 'Gala',
          templateIds: ['tpl_day'],
          opensAt: 1,
          closesAt: 2,
          reentry: true,
        },
      ],
      doors: [door({ admits: { events: ['gala'] } })],
    });
    expect(plan.sessions[0]?.settings).toMatchObject({
      direction: 'both',
      checkIn: { mode: 'in_out' },
    });
  });

  it('tracking: derived for any direction, kept when the door sets a check-in type', () => {
    const own = planned({ doors: [door({ more: { direction: 'in' } })] });
    expect(own.sessions[0]?.settings.checkIn).toEqual({ mode: 'in_out' });
    const device = planned({ doors: [door({ devices: [{ direction: 'out' }] })] });
    expect(device.sessions[0]?.settings.checkIn).toEqual({ mode: 'in_out' });
    const kept = planned({
      places: [gym],
      doors: [door({ place: 'gym-floor', more: { checkIn: { mode: 'daily', days: 1 } } })],
    });
    expect(kept.sessions[0]?.settings.checkIn).toEqual({ mode: 'daily', days: 1 });
    expect(kept.checks.map((c) => c.code)).toContain('DIRECTION_NEEDS_TRACKING');
  });

  it('hours come from the intent only: no silent default', () => {
    expect(planned({ doors: [door()] }).sessions[0]?.hours).toBeNull();
    const set = planned({ doors: [door({ hours: { sat: ['10:00-14:00'] } })] });
    expect(set.sessions[0]?.hours).toEqual({ sat: ['10:00-14:00'] });
  });

  it('no place and no re-entry: no direction, nothing counted, no tracking', () => {
    const plan = planned({ doors: [door({ devices: [{ reader: 'barcode' }] })] });
    expect(plan.sessions[0]?.settings.direction).toBeUndefined();
    expect(plan.sessions[0]?.settings.checkIn).toBeUndefined();
    expect(plan.sessions[0]?.devices[0]?.overrides).toEqual({ reader: 'barcode' });
    expect(plan.checks).toEqual([]);
    expect(plan.zones).toEqual([]);
  });

  it('a place with a max: track, 12 h max stay, clear at the last closing time', () => {
    const plan = planned({
      places: [gym],
      doors: [
        door({
          place: 'gym-floor',
          hours: { every: ['06:00-22:00'], sat: ['10:00-01:30'], closed: ['2026-12-25'] },
        }),
      ],
    });
    expect(plan.zones[0]).toMatchObject({
      occupancy: 'track',
      capacity: 60,
      maxStayMinutes: 720,
      clearAt: '01:30',
    });
    expect(plan.sessions[0]?.hours).toMatchObject({
      mon: ['06:00-22:00'],
      sat: ['10:00-01:30'],
      dates: { '2026-12-25': [] },
    });
    const always = planned({ places: [gym], doors: [door({ place: 'gym-floor' })] });
    expect(always.zones[0]?.clearAt).toBeNull();
  });

  it('a place nobody taps out of: tracked, but no direction and no exit check', () => {
    const plan = planned({
      places: [{ ...gym, tapOut: false }],
      doors: [door({ place: 'gym-floor' })],
    });
    expect(plan.zones[0]?.occupancy).toBe('track');
    expect(plan.sessions[0]?.settings.direction).toBeUndefined();
    expect(plan.checks.map((c) => c.code)).not.toContain('NO_EXIT');
  });

  it('staff sign in, or anyone as the chosen role', () => {
    const staff = planned({ doors: [door({ scanners: { by: 'staff' } })] });
    expect(staff.sessions[0]?.settings).toMatchObject({ staffSignIn: true });
    expect(staff.sessions[0]?.settings.roleWithoutSignIn).toBeUndefined();
    const anyone = planned({ doors: [door({ scanners: { by: 'anyone', as: 'desk' } })] });
    expect(anyone.sessions[0]?.settings).toMatchObject({
      staffSignIn: false,
      roleWithoutSignIn: 'desk',
    });
  });

  it('an event door: no zones and always open', () => {
    const plan = planned({ doors: [door({ admits: { events: ['event_gala'] } })] });
    expect(plan.sessions[0]).toMatchObject({ zones: [], hours: null });
    expect(plan.sessions[0]?.accepts?.events).toEqual([{ id: 'event_gala' }]);
  });

  it('layout customer is the customer role; operator turns lookup and photos back on', () => {
    const plan = planned({
      doors: [
        door({
          devices: [{ layout: 'customer' }, { layout: 'operator', name: 'Till' }],
          more: { lookup: false, showPhoto: false },
        }),
      ],
    });
    const [customer, operator] = plan.sessions[0]?.devices ?? [];
    expect(customer).toMatchObject({ role: 'customer', overrides: {} });
    expect(operator).toMatchObject({
      name: 'Till',
      surface: 'operator',
      overrides: { lookup: true, showPhoto: true },
    });
  });

  it('test mode: the plan is made in test', () => {
    const plan = planned({ doors: [door()] }, ctxOf({ mode: 'test' }));
    expect(plan.mode).toBe('test');
    expect(plan.checks.map((c) => c.code)).toContain('TEST_ONLY');
  });

  it('time zone: the intent, else the org, else UTC', () => {
    const own = planned({ timeZone: 'America/New_York', doors: [door()] });
    expect(own.sessions[0]?.timeZone).toBe('America/New_York');
    expect(planned({ doors: [door()] }).timeZone).toBe('Europe/Berlin');
    const unset = planned({ doors: [door()] }, ctxOf({ orgTimeZone: null }));
    expect(unset.timeZone).toBe('America/Los_Angeles');
    expect(unset.sessions[0]?.timeZone).toBe('America/Los_Angeles');
  });
});
