import type { WeeklyHours } from '@/passkit/types.ts';
import type { ScanRole } from '@/shared/contracts/scan.ts';
import type { ScanSetupPreset } from '@/shared/contracts/scan-setup-intent.ts';

export type Layout = 'phone' | 'operator' | 'customer' | 'barcode';
export type Direction = 'in' | 'out' | 'both';

export interface DeviceDraft {
  id: string;
  layout: Layout;
  /** Set only when the admin overrides the derived direction. */
  direction?: Direction | undefined;
}
export interface AreaDraft {
  ref: string;
  name: string;
  /** The ref of the area this one sits inside. */
  inside: string | null;
  max: string;
}
export interface EventDraft {
  ref: string;
  name: string;
  /** YYYY-MM-DD, HH:mm, HH:mm in the setup's time zone. */
  date: string;
  opens: string;
  closes: string;
  max: string;
  reentry: boolean;
}
export interface HoursDraft {
  mode: 'always' | 'set';
  from: string;
  to: string;
  /** Different on some days: `week` holds every day's spans. */
  split: boolean;
  week: WeeklyHours | undefined;
  closed: string[];
}
export interface StaffDraft {
  id: string;
  name: string;
  role: ScanRole;
}

export interface Draft {
  preset: ScanSetupPreset;
  name: string;
  count: boolean;
  area: string;
  max: string;
  areas: AreaDraft[];
  doorArea: string | null;
  any: boolean;
  templateIds: string[];
  /** Existing events the door admits. */
  eventIds: string[];
  events: EventDraft[];
  /** A template whose issued passes name upcoming events; the server reads them. */
  fromTemplate: string | null;
  fromIssued: boolean;
  hours: HoursDraft;
  scanners: 'anyone' | 'staff';
  as: 'door' | 'desk';
  staff: StaffDraft[];
  devices: DeviceDraft[];
  timeZone: string;
}

export const PRESETS: readonly ScanSetupPreset[] = ['front_desk', 'event_night', 'venue'];
export const isPreset = (v: unknown): v is ScanSetupPreset =>
  typeof v === 'string' && (PRESETS as readonly string[]).includes(v);

export const PRESET_LABEL: Record<ScanSetupPreset, string> = {
  front_desk: 'Front desk',
  event_night: 'Event night',
  venue: 'Several areas',
};
export const NAME_SUGGESTIONS: Record<ScanSetupPreset, readonly string[]> = {
  front_desk: ['Front desk', 'Main door', 'Reception'],
  event_night: ['Doors', 'Main entrance', 'Gate'],
  venue: ['Main door', 'Pool gate', 'Side entrance'],
};

export const LAYOUT_LABEL: Record<Layout, string> = {
  phone: 'Phone',
  operator: 'Tablet at the desk',
  customer: 'Customer screen',
  barcode: 'Barcode reader',
};
export const DIRECTION_LABEL: Record<Direction, string> = {
  in: 'In',
  out: 'Out',
  both: 'In and out',
};

let counter = 0;
export const uid = (prefix: string): string => `${prefix}${++counter}`;
export const newDevice = (layout: Layout = 'phone'): DeviceDraft => ({ id: uid('d'), layout });
export const newArea = (inside: string | null = null): AreaDraft => ({
  ref: `area-${uid('')}`,
  name: '',
  inside,
  max: '',
});
export const newEvent = (): EventDraft => ({
  ref: `event-${uid('')}`,
  name: '',
  date: '',
  opens: '',
  closes: '',
  max: '',
  reentry: false,
});

/** What each preset answers up front; the admin edits from there. */
export function initialDraft(
  preset: ScanSetupPreset,
  timeZone: string,
  fromTemplate: string | null = null,
): Draft {
  const base: Draft = {
    preset,
    name: NAME_SUGGESTIONS[preset][0] ?? '',
    count: false,
    area: '',
    max: '',
    areas: [],
    doorArea: null,
    any: false,
    templateIds: fromTemplate ? [fromTemplate] : [],
    eventIds: [],
    events: [],
    fromTemplate,
    fromIssued: fromTemplate !== null,
    hours: { mode: 'always', from: '', to: '', split: false, week: undefined, closed: [] },
    scanners: 'anyone',
    as: 'door',
    staff: [],
    devices: [newDevice('phone')],
    timeZone,
  };
  if (preset === 'front_desk')
    return { ...base, scanners: 'staff', devices: [newDevice('operator'), newDevice('phone')] };
  if (preset === 'venue') {
    const first = { ...newArea(), name: 'Gym' };
    return { ...base, areas: [first], doorArea: first.ref };
  }
  return base;
}

/** The rail: Event doors skip When. */
export const STEPS = [
  { id: 'where', title: 'Where' },
  { id: 'admits', title: 'Who gets in' },
  { id: 'when', title: 'When' },
  { id: 'scanners', title: 'Who scans' },
  { id: 'devices', title: 'Devices' },
  { id: 'review', title: 'Review' },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

export const eventCount = (d: Draft): number =>
  d.eventIds.length + d.events.length + (d.fromIssued && d.fromTemplate ? 1 : 0);
/** An event door admits events alone: the event's window decides when it is open. */
export const skipsWhen = (d: Draft): boolean =>
  d.preset === 'event_night' && !d.any && eventCount(d) > 0;

/** Next and Back hop over a skipped step. */
export function stepAfter(d: Draft, at: number, dir: 1 | -1): number {
  const next = at + dir;
  return STEPS[next]?.id === 'when' && skipsWhen(d) ? next + dir : next;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export function hoursProblem(h: HoursDraft): string | undefined {
  if (h.mode === 'always') return undefined;
  if (h.split) {
    const open = Object.values(h.week ?? {}).some((s) => s && s.length > 0);
    return open ? undefined : 'Add hours for at least one day.';
  }
  if (!TIME.test(h.from) || !TIME.test(h.to)) return 'Set when it opens and closes.';
  return h.from === h.to ? 'Opens and closes must differ.' : undefined;
}

export function eventProblem(e: EventDraft): string | undefined {
  if (!e.name.trim()) return 'Name the event.';
  if (!e.date || !TIME.test(e.opens) || !TIME.test(e.closes))
    return 'Set the date, opens and closes.';
  return undefined;
}

/** Why the step cannot go on yet, or undefined. Shown beside Next. */
export function stepProblem(d: Draft, step: StepId): string | undefined {
  switch (step) {
    case 'where':
      if (!d.name.trim()) return 'Name the door.';
      if (d.preset === 'front_desk' && d.count && !d.area.trim()) return 'Name the area.';
      if (d.preset === 'venue' && d.areas.some((a) => !a.name.trim())) return 'Name every area.';
      return undefined;
    case 'admits':
      if (!d.any && d.templateIds.length + eventCount(d) === 0)
        return 'Pick a pass type or an event.';
      if (d.events.length > 0 && d.templateIds.length === 0)
        return 'Pick the pass types for the event.';
      return d.events.map(eventProblem).find(Boolean);
    case 'when':
      return skipsWhen(d) ? undefined : hoursProblem(d.hours);
    case 'scanners':
      return d.scanners === 'staff' && d.staff.some((s) => !s.name.trim())
        ? 'Name every person.'
        : undefined;
    case 'devices':
      return d.devices.length === 0 ? 'Add a device.' : undefined;
    default:
      return undefined;
  }
}
