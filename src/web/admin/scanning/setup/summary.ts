import type { ScanSetupPlan } from '@/shared/contracts/scan-setup-intent.ts';
import { deviceName, sessionHoursOf } from '@/shared/scan-setup-plan-derive.ts';
import type { SetupPlanContext } from '@/shared/scan-setup-plan-types.ts';
import { formatCalendarDate } from '@/web/lib/format.ts';
import { hoursSummary } from '../sessions/session-hours.ts';
import {
  DIRECTION_LABEL,
  type Direction,
  type Draft,
  type EventDraft,
  LAYOUT_LABEL,
  type StepId,
  skipsWhen,
  whereOf,
} from './draft.ts';
import { hoursOf } from './intent.ts';

export type LineKey = 'admits' | 'where' | 'when' | 'scanners' | 'devices';
/** The five answers, in the order every summary shows them. */
export const LINE_ORDER: readonly { key: LineKey; label: string; step: StepId }[] = [
  { key: 'admits', label: 'Who gets in', step: 'admits' },
  { key: 'where', label: 'Where', step: 'where' },
  { key: 'when', label: 'When', step: 'when' },
  { key: 'scanners', label: 'Who scans', step: 'scanners' },
  { key: 'devices', label: 'Devices', step: 'devices' },
];

export interface SummaryLine {
  key: LineKey;
  label: string;
  step: StepId;
  /** Null: not answered yet. */
  value: string | null;
  detail: string[];
}

const ROLE = { door: 'Door', desk: 'Desk', manager: 'Manager' } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function eventLine(e: EventDraft): string {
  const when = e.date ? `${formatCalendarDate(e.date)} ${e.opens}–${e.closes}` : '';
  return [e.name || 'Event', when, e.max && `${e.max} max`, e.reentry && 'Re-entry']
    .filter(Boolean)
    .join(' · ');
}

/** The direction each device scans: the planner's derived value, else the admin's own. */
export function directionsOf(d: Draft, plan: ScanSetupPlan | undefined): Direction[] {
  const session = plan?.sessions[0];
  return d.devices.map((v, i) => {
    const planned = session?.devices[i];
    return v.direction ?? planned?.overrides.direction ?? session?.settings.direction ?? 'in';
  });
}

export function doorLines(
  d: Draft,
  ctx: SetupPlanContext,
  plan: ScanSetupPlan | undefined,
): SummaryLine[] {
  const nameOf = (id: string) => ctx.templates.find((t) => t.id === id)?.name ?? 'Pass type';
  const events = [
    ...d.events.map(eventLine),
    ...d.eventIds.map((id) => ctx.events.find((e) => e.id === id)?.name ?? 'Event'),
  ];
  const admitted = d.templateIds.map(nameOf);
  const eventCap = d.events.find((e) => e.max)?.max;
  const place =
    whereOf(d.preset) === 'areas'
      ? d.areas.find((a) => a.ref === d.doorArea)
      : whereOf(d.preset) === 'count' && d.count
        ? { name: d.area, max: d.max }
        : undefined;
  const where = place?.name
    ? `${place.name}${place.max ? `, max ${place.max}` : ''}`
    : d.preset === 'event_night' && eventCap
      ? `${d.events.find((e) => e.max)?.name ?? 'Event'}, max ${eventCap}`
      : null;
  const hours = skipsWhen(d) ? null : sessionHoursOf(hoursOf(d));
  const week = hours && hours !== 'empty' ? hoursSummary(hours) : [];
  const dirs = directionsOf(d, plan);
  const staff = d.staff.map((s) => `${s.name || 'Unnamed'} (${ROLE[s.role]})`);
  const lines: Record<LineKey, Pick<SummaryLine, 'value' | 'detail'>> = {
    admits: d.any
      ? { value: 'Any pass type', detail: events }
      : admitted.length + events.length === 0
        ? { value: null, detail: [] }
        : {
            value: admitted.join(', ') || events[0] || null,
            detail: admitted.length ? events : events.slice(1),
          },
    where: { value: where, detail: [] },
    when: skipsWhen(d)
      ? { value: 'Event hours', detail: [] }
      : d.hours.mode === 'always'
        ? {
            value: 'Always open',
            detail: d.hours.closed.length
              ? [`Closed ${d.hours.closed.map(formatCalendarDate).join(', ')}`]
              : [],
          }
        : { value: week[0] ?? null, detail: week.slice(1) },
    scanners:
      d.scanners === 'staff'
        ? { value: 'Staff PIN', detail: staff }
        : { value: `Anyone, as ${ROLE[d.as]}`, detail: [] },
    devices: {
      value: plural(d.devices.length, 'device'),
      detail: [
        d.devices
          .map(
            (v, i) =>
              `${LAYOUT_LABEL[v.layout]}${v.layout === 'customer' ? '' : ` (${DIRECTION_LABEL[dirs[i] ?? 'in']})`}`,
          )
          .join(', '),
      ],
    },
  };
  return LINE_ORDER.map((l) => ({ ...l, ...lines[l.key] }));
}

/** The server names devices "<door> 1", "<door> 2"; so does the wizard, until they exist. */
export const deviceNames = (d: Draft): string[] =>
  d.devices.map((_v, i) => deviceName(d.name.trim() || 'Door', i + 1));

const CHECK_IN = {
  single: 'once',
  daily: 'once a day',
  unlimited: 'unlimited',
  in_out: 'in and out',
} as const;

/** What the planned session settings add beyond the five answers: "Check-in: once a day · Hard limit". */
export function settingsLine(
  session: ScanSetupPlan['sessions'][number] | undefined,
): string | null {
  if (!session) return null;
  const s = session.settings;
  const mode = s.checkIn?.mode;
  const parts = [
    mode ? `Check-in: ${CHECK_IN[mode]}` : null,
    s.hardLimit ? 'Hard limit' : null,
    s.offline && s.whenOffline === 'list' ? 'Offline list' : null,
    session.devices.some((d) => d.surface === 'customer') ? 'Customer screen' : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}
