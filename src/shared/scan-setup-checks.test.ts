import { describe, expect, it } from 'vitest';
import { SCAN_SETUP_COPY } from './copy/scan-setup.ts';
import {
  type DoorFacts,
  hasErrors,
  type SetupCheckFacts,
  setupChecks,
} from './scan-setup-checks.ts';

const phone = (over: Partial<DoorFacts['devices'][number]> = {}): DoorFacts['devices'][number] => ({
  ref: 'dev_1',
  name: 'Door 1',
  role: 'scan',
  direction: 'both',
  reader: 'none',
  ...over,
});
const gym = {
  ref: 'zone_gym',
  name: 'Gym',
  keys: ['gym', 'club'],
  counted: true,
  exits: true,
  max: 60,
};
/** A live session as the session page maps it: ids for refs. */
const door = (over: Partial<DoorFacts> = {}): DoorFacts => ({
  ref: 'session_1',
  name: 'Front desk',
  eventOnly: false,
  place: null,
  events: [],
  templates: [],
  hours: null,
  direction: null,
  tracks: false,
  staffSignIn: false,
  devices: [phone({ direction: null })],
  ...over,
});
const facts = (doors: DoorFacts[], over: Partial<SetupCheckFacts> = {}): SetupCheckFacts => ({
  mode: 'live',
  staff: [{ role: 'manager', active: true }],
  doors,
  ...over,
});
const codes = (f: SetupCheckFacts) => setupChecks(f).map((c) => c.code);
const tracked = { direction: 'both' as const, tracks: true };

describe('setupChecks', () => {
  it('a plain door passes', () => {
    expect(setupChecks(facts([door()]))).toEqual([]);
  });

  it('NO_EXIT: a counted place or re-entry with no device that scans out', () => {
    const inOnly = door({ ...tracked, place: gym, devices: [phone({ direction: 'in' })] });
    const [check] = setupChecks(facts([inOnly]));
    expect(check).toMatchObject({
      code: 'NO_EXIT',
      level: 'warn',
      params: { place: 'Gym' },
      fix: { kind: 'device_direction', device: 'dev_1', direction: 'both' },
    });
    const reentry = door({
      ...tracked,
      events: [{ ref: 'e', name: 'Gala', reentry: true, max: null, issued: 1 }],
      devices: [phone({ direction: 'in', reader: 'barcode' })],
    });
    expect(setupChecks(facts([reentry]))[0]?.fix).toEqual({
      kind: 'add_device',
      session: 'session_1',
      direction: 'out',
    });
    expect(codes(facts([door({ ...tracked, place: gym, devices: [phone()] })]))).toEqual([]);
    // Revoking the exit device brings it back.
    const revoked = door({
      ...tracked,
      place: gym,
      devices: [phone({ direction: 'in' }), phone({ ref: 'dev_2', revoked: true })],
    });
    expect(codes(facts([revoked]))).toEqual(['NO_EXIT']);
    const noTapOut = door({
      ...tracked,
      place: { ...gym, exits: false },
      devices: [phone({ direction: 'in' })],
    });
    expect(codes(facts([noTapOut]))).toEqual([]);
  });

  it('NO_MANAGER: a max, staff sign in, and no active Manager', () => {
    const d = door({ ...tracked, place: gym, staffSignIn: true, devices: [phone()] });
    const desk = {
      staff: [
        { role: 'desk' as const, active: true },
        { role: 'manager' as const, active: false },
      ],
    };
    expect(codes(facts([d], desk))).toEqual(['NO_MANAGER']);
    expect(codes(facts([d]))).toEqual([]);
    expect(codes(facts([{ ...d, place: { ...gym, max: null } }], desk))).toEqual([]);
  });

  it('NO_STAFF: staff sign in with no active staff is an error', () => {
    const d = door({ staffSignIn: true });
    const none = facts([d], { staff: [{ role: 'manager', active: false }] });
    expect(codes(none)).toEqual(['NO_STAFF']);
    expect(hasErrors(setupChecks(none))).toBe(true);
    expect(codes(facts([d]))).toEqual([]);
  });

  it('PLAN_MISSES_PLACE: an Access card with no plan for the zone, a parent or *', () => {
    const plans = (zones: string[]) => [{ id: 'p', label: 'Pool', zones, hours: null }];
    const card = (zones: string[]) =>
      door({
        ...tracked,
        place: gym,
        devices: [phone()],
        templates: [{ id: 'tpl_a', name: 'Pool card', plans: plans(zones) }],
      });
    expect(setupChecks(facts([card(['pool'])]))[0]).toMatchObject({
      code: 'PLAN_MISSES_PLACE',
      level: 'warn',
      fix: { kind: 'open_template', templateId: 'tpl_a' },
    });
    expect(codes(facts([card(['gym'])]))).toEqual([]);
    expect(codes(facts([card(['club'])]))).toEqual([]);
    expect(codes(facts([card(['*'])]))).toEqual([]);
    const plain = door({
      ...tracked,
      place: gym,
      devices: [phone()],
      templates: [{ id: 't', name: 'Day', plans: null }],
    });
    expect(codes(facts([plain]))).toEqual([]);
  });

  it('HOURS_DIFFER: the door and a plan never overlap on a day', () => {
    const t = (hours: Record<string, string[]>) => ({
      id: 'tpl_a',
      name: 'Monthly',
      plans: [{ id: 'early', label: 'Early', zones: ['*'], hours }],
    });
    const d = (hours: Record<string, string[]>) =>
      door({ hours: { mon: ['18:00-02:00'], tue: ['09:00-12:00'] }, templates: [t(hours)] });
    const [check] = setupChecks(facts([d({ tue: ['13:00-14:00'] })]));
    expect(check).toMatchObject({ code: 'HOURS_DIFFER', level: 'info', params: { day: 'tue' } });
    expect(codes(facts([d({ mon: ['01:00-03:00'] })]))).toEqual([]);
    expect(codes(facts([d({ wed: ['01:00-03:00'] })]))).toEqual([]);
    expect(codes(facts([door({ templates: [t({ tue: ['13:00-14:00'] })] })]))).toEqual([]);
  });

  it('EVENT_NO_PASSES: once per event, across doors', () => {
    const e = { ref: 'gala', name: 'Gala', reentry: false, max: null, issued: 0 };
    const f = facts([
      door({ eventOnly: true, events: [e] }),
      door({ ref: 's2', eventOnly: true, events: [e] }),
    ]);
    expect(setupChecks(f)).toEqual([
      expect.objectContaining({ code: 'EVENT_NO_PASSES', level: 'info', door: 'session_1' }),
    ]);
    expect(codes(facts([door({ eventOnly: true, events: [{ ...e, issued: 3 }] })]))).toEqual([]);
  });

  it('READER_BOTH: a barcode reader set to both is an error', () => {
    const d = door({ ...tracked, devices: [phone({ reader: 'barcode' })] });
    expect(setupChecks(facts([d]))[0]).toMatchObject({
      code: 'READER_BOTH',
      level: 'error',
      fix: { kind: 'device_direction', device: 'dev_1', direction: 'in' },
    });
    expect(codes(facts([door({ ...tracked, devices: [phone()] })]))).toEqual([]);
  });

  it('PLACE_ON_EVENT: an event door with a zone is an error', () => {
    const e = { ref: 'gala', name: 'Gala', reentry: false, max: null, issued: 1 };
    const d = door({ ...tracked, eventOnly: true, events: [e], place: gym, devices: [phone()] });
    expect(codes(facts([d]))).toEqual(['PLACE_ON_EVENT']);
    expect(codes(facts([{ ...d, place: null }]))).toEqual([]);
  });

  it('DIRECTION_NEEDS_TRACKING: a direction or re-entry without Track in / out', () => {
    expect(codes(facts([door({ direction: 'in' })]))).toEqual(['DIRECTION_NEEDS_TRACKING']);
    expect(codes(facts([door({ devices: [phone({ direction: 'out' })] })]))).toEqual([
      'DIRECTION_NEEDS_TRACKING',
    ]);
    const e = { ref: 'gala', name: 'Gala', reentry: true, max: null, issued: 1 };
    const [check] = setupChecks(facts([door({ events: [e] })]));
    expect(check).toMatchObject({
      level: 'error',
      fix: { kind: 'track_in_out', session: 'session_1' },
    });
    expect(codes(facts([door({ direction: 'in', tracks: true })]))).toEqual([]);
  });

  it('TEST_ONLY: test mode', () => {
    expect(codes(facts([door()], { mode: 'test' }))).toEqual(['TEST_ONLY']);
  });

  it('every message key has copy', () => {
    const keys = Object.keys(SCAN_SETUP_COPY.checks);
    const all = setupChecks(
      facts(
        [
          door({
            direction: 'in',
            staffSignIn: true,
            place: gym,
            eventOnly: true,
            devices: [phone({ reader: 'barcode', direction: 'in' })],
          }),
        ],
        { mode: 'test', staff: [] },
      ),
    );
    for (const c of all) expect(keys).toContain(c.message);
  });
});
