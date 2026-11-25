import type { WeeklyHours } from '@/passkit/types.ts';
import type { ScanRole } from '@/shared/contracts/scan.ts';
import type { ScanSetupPreset } from '@/shared/contracts/scan-setup-intent.ts';
import { SCAN_SETUP_PRESET_IDS } from '@/shared/scan-setup-preset-ids.ts';
import { PRESET_SPECS } from '@/shared/scan-setup-presets.ts';

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

export const PRESETS: readonly ScanSetupPreset[] = SCAN_SETUP_PRESET_IDS;
export const isPreset = (v: unknown): v is ScanSetupPreset =>
  typeof v === 'string' && (PRESETS as readonly string[]).includes(v);

export const presetLabel = (p: ScanSetupPreset): string => PRESET_SPECS[p].label;
export const nameSuggestions = (p: ScanSetupPreset): readonly string[] => PRESET_SPECS[p].names;
/** A hard limit caps nothing without a max. */
export const needsMax = (p: ScanSetupPreset): boolean => PRESET_SPECS[p].more.hardLimit === true;
const whole = (v: string): boolean => Number.isInteger(Number(v)) && Number(v) >= 1;
/** What Where asks for: nothing, one counted area, or an area tree. */
export const whereOf = (p: ScanSetupPreset) => PRESET_SPECS[p].where;

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

const span = /^(\d\d:\d\d)-(\d\d:\d\d)$/;

/** What each preset answers up front, read from its spec; the admin edits from there. */
export function initialDraft(
  preset: ScanSetupPreset,
  timeZone: string,
  fromTemplate: string | null = null,
): Draft {
  const spec = PRESET_SPECS[preset];
  const every = spec.hours && typeof spec.hours === 'object' ? spec.hours.every?.[0] : undefined;
  const [, from = '', to = ''] = (every ? span.exec(every) : null) ?? [];
  const base: Draft = {
    preset,
    name: spec.names[0],
    count: spec.count !== undefined,
    area: spec.count ?? '',
    max: '',
    areas: [],
    doorArea: null,
    any: false,
    templateIds: fromTemplate ? [fromTemplate] : [],
    eventIds: [],
    events: [],
    fromTemplate,
    fromIssued: fromTemplate !== null,
    hours: { mode: every ? 'set' : 'always', from, to, split: false, week: undefined, closed: [] },
    scanners: spec.scanners.by,
    as: spec.scanners.by === 'anyone' ? spec.scanners.as : 'door',
    staff: [],
    devices: spec.devices.map((v) => ({
      id: uid('d'),
      layout:
        v.reader === 'barcode' ? 'barcode' : v.layout === 'auto' || !v.layout ? 'phone' : v.layout,
      ...(v.direction ? { direction: v.direction } : {}),
    })),
    timeZone,
  };
  if (spec.where === 'areas') {
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
      if (whereOf(d.preset) === 'count' && d.count && !d.area.trim()) return 'Name the area.';
      if (needsMax(d.preset) && !(d.count && whole(d.max))) return 'Set the max inside.';
      if (whereOf(d.preset) === 'areas' && d.areas.some((a) => !a.name.trim()))
        return 'Name every area.';
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
