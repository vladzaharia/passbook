import { describe, expect, it } from 'vitest';
import { CreateScanZoneSchema } from './contracts/scan-access.ts';
import { ScanSetupIntentSchema, ScanSetupPlanSchema } from './contracts/scan-setup-intent.ts';
import { CreateScanEventSchema, CreateScanStaffSchema } from './contracts/scanners.ts';
import {
  CreateScanningDeviceSchema,
  CreateScanningSessionSchema,
} from './contracts/scanning-sessions.ts';
import { planBodies } from './scan-setup-plan-bodies.ts';
import { codes, ctxOf, ORG, plan, planned } from './scan-setup-plan-test-fixtures.ts';

const door = (over: Record<string, unknown> = {}) => ({
  name: 'Door',
  admits: { templateIds: ['tpl_day'] },
  ...over,
});
const event = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  name: ref,
  templateIds: ['tpl_day'],
  opensAt: 1,
  closesAt: 2,
  ...over,
});

describe('planScanSetup refs', () => {
  it('refuses an unknown ref, a duplicate and a ref of the wrong kind', () => {
    expect(codes({ doors: [door({ place: 'nowhere' })] })).toEqual(['SETUP_REF_UNKNOWN']);
    expect(codes({ doors: [door({ admits: { events: ['nothing'] } })] })).toEqual([
      'SETUP_REF_UNKNOWN',
    ]);
    expect(
      codes({ places: [{ ref: 'a', name: 'A' }], events: [event('a')], doors: [door()] }),
    ).toEqual(['SETUP_REF_DUPLICATE']);
    expect(
      codes({ places: [{ ref: 'a', name: 'A' }], doors: [door({ admits: { events: ['a'] } })] }),
    ).toEqual(['SETUP_REF_KIND']);
    expect(codes({ events: [event('e')], doors: [door({ place: 'e' })] })).toEqual([
      'SETUP_REF_KIND',
    ]);
  });

  it('refuses unknown or archived ids', () => {
    expect(codes({ doors: [door({ place: 'zone_nope' })] })).toEqual(['ZONE_NOT_FOUND']);
    expect(codes({ doors: [door({ place: 'zone_old' })] })).toEqual(['ZONE_ARCHIVED']);
    expect(codes({ places: [{ zoneId: 'zone_old' }], doors: [door()] })).toEqual(['ZONE_ARCHIVED']);
    expect(codes({ events: [{ eventId: 'event_nope' }], doors: [door()] })).toEqual([
      'EVENT_NOT_FOUND',
    ]);
    expect(codes({ doors: [door({ admits: { templateIds: ['tpl_nope'] } })] })).toEqual([
      'TEMPLATE_NOT_FOUND',
    ]);
    expect(codes({ events: [event('e', { closesAt: 1 })], doors: [door()] })).toEqual([
      'SETUP_CLOSES_BEFORE_OPENS',
    ]);
  });

  it('refuses a cycle in inside and a tree deeper than three', () => {
    const cycle = codes({
      places: [
        { ref: 'a', name: 'A', inside: 'b' },
        { ref: 'b', name: 'B', inside: 'a' },
      ],
      doors: [door()],
    });
    expect(cycle).toEqual(['ZONE_CYCLE', 'ZONE_CYCLE']);
    const chain = ['a', 'b', 'c', 'd', 'e'].map((ref, i, all) => ({
      ref,
      name: ref,
      ...(i > 0 ? { inside: all[i - 1] } : {}),
    }));
    expect(codes({ places: chain, doors: [door()] })).toEqual(['ZONE_DEPTH']);
    expect(codes({ places: chain.slice(0, 4), doors: [door()] })).toEqual([]);
    // Under an existing root, three new levels is one too many.
    const under = chain.slice(0, 3).map((p, i) => (i === 0 ? { ...p, inside: 'zone_gym' } : p));
    expect(codes({ places: under, doors: [door()] })).toEqual([]);
    const deep = [...under, { ref: 'x', name: 'X', inside: 'c' }];
    expect(codes({ places: deep, doors: [door()] })).toEqual(['ZONE_DEPTH']);
  });

  it('makes zone keys unique and refuses a taken explicit key', () => {
    const p = planned({
      places: [
        { ref: 'a', name: 'Gym' },
        { ref: 'b', name: 'Gym' },
      ],
      doors: [door()],
    });
    expect(p.zones.map((z) => z.key)).toEqual(['gym-2', 'gym-3']);
    expect(codes({ places: [{ ref: 'a', name: 'A', key: 'gym' }], doors: [door()] })).toEqual([
      'ZONE_KEY_TAKEN',
    ]);
  });

  it('expands fromTemplate into new and existing events, and its ref admits the template', () => {
    const ctx = ctxOf();
    const ticket = ctx.templates[2];
    if (ticket)
      ticket.upcomingEvents = [
        {
          name: 'Fri',
          opensAt: 1,
          closesAt: 2,
          timeZone: null,
          match: null,
          existingId: 'event_gala',
        },
        {
          name: 'Sat',
          opensAt: 3,
          closesAt: 4,
          timeZone: 'Europe/Paris',
          match: { input: 'date', value: 'sat' },
          existingId: null,
        },
      ];
    const p = planned(
      {
        events: [{ fromTemplate: 'tpl_ticket', ref: 'shows' }],
        doors: [door({ admits: { events: ['shows'] } })],
      },
      ctx,
    );
    expect(p.events).toEqual([
      expect.objectContaining({
        ref: 'shows-2',
        timeZone: 'Europe/Paris',
        match: { input: 'date', values: ['sat'] },
      }),
    ]);
    expect(p.sessions[0]?.accepts).toEqual({
      templateIds: ['tpl_ticket'],
      events: [{ id: 'event_gala' }, { ref: 'shows-2' }],
    });
    expect(p.checks.filter((c) => c.code === 'EVENT_NO_PASSES')).toHaveLength(2);
  });
});

describe('planScanSetup limits', () => {
  it('the intent schema refuses 9 places, 11 events, 101 templates, 11 devices and 9 doors', () => {
    const parse = (over: Record<string, unknown>) =>
      ScanSetupIntentSchema.safeParse({ orgId: ORG, doors: [door()], ...over }).success;
    expect(parse({})).toBe(true);
    expect(
      parse({ places: Array.from({ length: 9 }, (_, i) => ({ ref: `p${i}`, name: 'P' })) }),
    ).toBe(false);
    expect(parse({ events: Array.from({ length: 11 }, (_, i) => event(`e${i}`)) })).toBe(false);
    const ids = Array.from({ length: 101 }, (_, i) => `tpl_${i}`);
    expect(parse({ doors: [door({ admits: { templateIds: ids } })] })).toBe(false);
    expect(parse({ doors: [door({ devices: Array.from({ length: 11 }, () => ({})) })] })).toBe(
      false,
    );
    expect(parse({ doors: Array.from({ length: 9 }, () => door()) })).toBe(false);
    expect(parse({ doors: [] })).toBe(false);
    expect(parse({ doors: [door({ extra: 1 })] })).toBe(false);
    expect(parse({ places: [{ ref: 'Bad_Ref', name: 'P' }] })).toBe(false);
  });

  it('refuses a door whose events bring more than 100 templates, or nothing admitted', () => {
    const many = Array.from({ length: 100 }, (_, i) => `tpl_${i}`);
    const ctx = ctxOf();
    ctx.templates.push(
      ...many.map((id) => ({ id, name: id, plans: null, issued: { live: 1, test: 0 } })),
    );
    const r = plan(
      {
        events: [event('e', { templateIds: ['tpl_ticket'] })],
        doors: [door({ admits: { templateIds: many, events: ['e'] } })],
      },
      ctx,
    );
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(['SETUP_TOO_MANY_TEMPLATES']);
    expect(codes({ doors: [door({ admits: { templateIds: [] } })] })).toEqual([
      'SETUP_ADMITS_EMPTY',
    ]);
    expect(codes({ doors: [door({ hours: { closed: ['2026-12-25'] } })] })).toEqual([
      'SETUP_HOURS_EMPTY',
    ]);
  });
});

describe('planScanSetup output', () => {
  it('every object parses with the existing create schemas, and the plan with its own', () => {
    const p = planned({
      preset: 'front_desk',
      places: [
        { ref: 'club', name: 'Club', count: true, clearAt: '23:00' },
        { ref: 'pool', name: 'Pool', inside: 'club', max: 12, maxStayMinutes: 90 },
        { zoneId: 'zone_gym' },
      ],
      events: [event('gala', { max: 300, reentry: true })],
      staff: [{ name: 'Maya Chen', role: 'manager' }],
      doors: [
        {
          name: 'Front desk',
          place: 'club',
          admits: { templateIds: ['tpl_gym', 'tpl_day'] },
          hours: { every: ['06:00-22:00'] },
        },
        {
          name: 'Pool',
          place: 'pool',
          admits: { any: true },
          devices: [{ reader: 'barcode' }, { layout: 'customer' }],
        },
        {
          name: 'Gym',
          place: 'zone_gym',
          admits: { templateIds: ['tpl_gym'], events: ['gala', 'event_gala'] },
        },
        { name: 'Gala doors', admits: { events: ['gala'] } },
      ],
    });
    expect(ScanSetupPlanSchema.parse(p)).toEqual(p);
    const bodies = planBodies(p, ORG, (ref) => `id_${ref}`);
    for (const z of bodies.zones) CreateScanZoneSchema.parse(z);
    for (const e of bodies.events) CreateScanEventSchema.parse(e);
    for (const s of bodies.staff) CreateScanStaffSchema.parse(s);
    for (const s of bodies.sessions) {
      CreateScanningSessionSchema.parse(s.body);
      for (const d of s.devices) CreateScanningDeviceSchema.parse(d.body);
    }
    expect(bodies.zones.map((z) => z.parentId)).toEqual([null, 'id_club']);
    expect(bodies.sessions[2]?.body.accepts).toEqual({
      templateIds: ['tpl_gym'],
      eventIds: ['id_gala', 'event_gala'],
    });
    expect(bodies.sessions[1]?.body.accepts).toBeNull();
  });
});
