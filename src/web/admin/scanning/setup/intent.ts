import type { AccessDay } from '@/passkit/types.ts';
import type {
  ScanSetupFix,
  ScanSetupIntent,
  SetupDoor,
  SetupEvent,
  SetupHours,
  SetupPlace,
} from '@/shared/contracts/scan-setup-intent.ts';
import { PRESET_SPECS } from '@/shared/scan-setup-presets.ts';
import { localToIso } from '../../passes/schema-form/datetime.ts';
import { type Draft, type EventDraft, eventCount, skipsWhen, uid, whereOf } from './draft.ts';

const DAYS: readonly AccessDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const FRONT_AREA = 'area-1';
export const TEMPLATE_EVENTS = 'template-events';
const whole = (v: string): number | undefined => {
  const n = Math.floor(Number(v));
  return v.trim() !== '' && Number.isFinite(n) && n >= 1 ? n : undefined;
};

function placesOf(d: Draft): SetupPlace[] {
  if (whereOf(d.preset) === 'areas')
    return d.areas.map((a) => {
      const max = whole(a.max);
      return {
        ref: a.ref,
        name: a.name.trim(),
        ...(a.inside ? { inside: a.inside } : {}),
        ...(max ? { max } : { count: true }),
      };
    });
  if (whereOf(d.preset) === 'count' && d.count) {
    const max = whole(d.max);
    return [{ ref: FRONT_AREA, name: d.area.trim(), ...(max ? { max } : { count: true }) }];
  }
  return [];
}
const placeOf = (d: Draft): string | null =>
  whereOf(d.preset) === 'areas'
    ? d.doorArea
    : whereOf(d.preset) === 'count' && d.count
      ? FRONT_AREA
      : null;

function eventsOf(d: Draft): SetupEvent[] {
  const made = d.events.map((e: EventDraft): SetupEvent => {
    const at = (time: string) => Date.parse(localToIso(`${e.date}T${time}`, d.timeZone) ?? '');
    const max = whole(e.max);
    return {
      ref: e.ref,
      name: e.name.trim(),
      templateIds: d.templateIds,
      opensAt: at(e.opens),
      closesAt: at(e.closes),
      ...(max ? { max } : {}),
      reentry: e.reentry,
    };
  });
  const existing = d.eventIds.map((eventId): SetupEvent => ({ eventId }));
  const issued: SetupEvent[] =
    d.fromIssued && d.fromTemplate ? [{ fromTemplate: d.fromTemplate, ref: TEMPLATE_EVENTS }] : [];
  return [...made, ...existing, ...issued];
}

/** Hours as the intent takes them: the same span for every day, or each day's own. */
export function hoursOf(d: Draft): SetupHours | undefined {
  const h = d.hours;
  if (h.mode === 'always') return undefined;
  const closed = h.closed.length > 0 ? { closed: h.closed } : {};
  if (!h.split) return { every: [`${h.from}-${h.to}`], ...closed };
  const days = Object.fromEntries(
    DAYS.flatMap((day) => {
      const spans = h.week?.[day];
      return spans && spans.length > 0 ? [[day, spans]] : [];
    }),
  );
  return { ...days, ...closed };
}

function doorOf(d: Draft): SetupDoor {
  // A preset with its own hours fills them unless the answer says always.
  const hours = skipsWhen(d)
    ? undefined
    : (hoursOf(d) ?? (PRESET_SPECS[d.preset].hours ? ('always' as const) : undefined));
  const events = [...d.events.map((e) => e.ref), ...d.eventIds];
  if (d.fromIssued && d.fromTemplate) events.push(TEMPLATE_EVENTS);
  const viaEvents = d.preset === 'event_night' && eventCount(d) > 0;
  const place = placeOf(d);
  return {
    name: d.name.trim(),
    ...(place ? { place } : {}),
    admits: d.any ? { any: true } : { templateIds: viaEvents ? [] : d.templateIds, events: events },
    ...(hours ? { hours } : {}),
    scanners: d.scanners === 'staff' ? { by: 'staff' } : { by: 'anyone', as: d.as },
    devices: d.devices.map((v) => ({
      layout: v.layout === 'barcode' ? 'phone' : v.layout,
      ...(v.layout === 'barcode' ? { reader: 'barcode' as const } : {}),
      ...(v.direction ? { direction: v.direction } : {}),
    })),
  };
}

/** The wizard's answers as the intent the planner and the server take. */
export function toIntent(d: Draft, orgId: string): ScanSetupIntent {
  return {
    orgId,
    preset: d.preset,
    timeZone: d.timeZone,
    places: placesOf(d),
    events: eventsOf(d),
    staff:
      d.scanners === 'staff' ? d.staff.map(({ name, role }) => ({ name: name.trim(), role })) : [],
    doors: [doorOf(d)],
  };
}

/** The device a plan ref (`door-1-2`) names: its place in the draft. */
const deviceAt = (ref: string): number => Number(ref.split('-').at(-1)) - 1;

/**
 * One tap on a check's fix, as an edit of the answers. Returns the draft unchanged when the fix
 * has nothing to edit here (open_template leaves for the designer).
 */
export function applyFix(d: Draft, fix: ScanSetupFix): Draft {
  switch (fix.kind) {
    case 'device_direction':
      return {
        ...d,
        devices: d.devices.map((v, i) =>
          i === deviceAt(fix.device) ? { ...v, direction: fix.direction } : v,
        ),
      };
    case 'add_device':
      return {
        ...d,
        devices: [...d.devices, { id: uid('d'), layout: 'phone', direction: fix.direction }],
      };
    case 'add_staff': {
      const person = d.staff.find((s) => s.role !== 'manager');
      return {
        ...d,
        scanners: 'staff',
        staff: person
          ? d.staff.map((s) => (s === person ? { ...s, role: 'manager' } : s))
          : [...d.staff, { id: uid('s'), name: 'Manager', role: 'manager' }],
      };
    }
    case 'remove_place':
      return {
        ...d,
        count: false,
        doorArea: null,
        areas: whereOf(d.preset) === 'areas' ? [] : d.areas,
      };
    case 'track_in_out':
    case 'open_template':
      return d;
  }
}

/** The person an add_staff fix would promote, for its button label. */
export const promotable = (d: Draft) => d.staff.find((s) => s.role !== 'manager');
