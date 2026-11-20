import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import type { ScannerSettings } from '../../../shared/contracts/scan.ts';
import { SessionHoursSchema } from '../../../shared/contracts/scanning-sessions.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** An event with a start and no end counts as running this long (as in the upcoming-events behavior). */
const FALLBACK_MINUTES = 180;
const MAX_EVENTS = 10;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface PlannedEvent {
  name: string;
  opensAt: number;
  closesAt: number;
  timeZone: string | null;
  venue: string | null;
}
export interface TemplateScanPlan {
  events: PlannedEvent[];
  /** Names of events the template lists with no date. */
  undated: string[];
  checkIn: ScannerSettings['checkIn'] | undefined;
}

const text = (v: Json | undefined): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const instant = (v: Json | undefined): number | undefined => {
  const s = text(v);
  const ms = s === undefined ? Number.NaN : Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
};
const row = (v: Json | undefined): Record<string, Json> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v : undefined;

function validZone(zone: string | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function eventOf(
  r: Record<string, Json>,
  window: NonNullable<TemplateManifest['scan']>['window'],
  doorsAt: number | undefined,
  zone: string | null,
): PlannedEvent | { undated: string } | null {
  const name = text(r.name)?.slice(0, 80);
  if (!name) return null;
  const start = instant(r.startsAt);
  if (start === undefined) return { undated: name };
  const rawEnd = instant(r.endsAt);
  const end = rawEnd !== undefined && rawEnd > start ? rawEnd : start + FALLBACK_MINUTES * MINUTE;
  const venue = [text(r.venueName), text(r.venueRegion)].filter(Boolean).join(', ').slice(0, 140);
  return {
    name,
    opensAt:
      doorsAt !== undefined && doorsAt < start
        ? doorsAt
        : start - (window?.earlyMinutes ?? 0) * MINUTE,
    closesAt: end + (window?.lateMinutes ?? 0) * MINUTE,
    timeZone: validZone(text(r.timeZone)) ?? zone,
    venue: venue || null,
  };
}

/**
 * What a template's own data says about its events: the single event its sample pass describes
 * (a ticket) and every entry of an upcoming-events list. A door template has none.
 */
export function planTemplateScan(
  manifest: TemplateManifest,
  passJson: PassJson,
  now: number,
): TemplateScanPlan {
  const sample = manifest.sample ?? {};
  const scan = manifest.scan;
  const semantics = (passJson as { semantics?: Record<string, Json> }).semantics ?? {};
  const zone = validZone(text(sample.venueTimeZone));
  const fromInput = scan?.window?.from;
  const own = eventOf(
    {
      name: sample.eventName ?? semantics.eventName ?? null,
      startsAt:
        (fromInput ? sample[fromInput] : undefined) ??
        sample.startsAt ??
        semantics.eventStartDate ??
        null,
      endsAt: sample.endsAt ?? semantics.eventEndDate ?? null,
      venueName: sample.venueName ?? semantics.venueName ?? null,
      venueRegion: sample.venueRegion ?? semantics.venueRegionName ?? null,
    },
    scan?.window,
    instant(sample.doorsAt),
    zone,
  );
  const events: PlannedEvent[] = [];
  const undated: string[] = [];
  if (own) {
    if ('undated' in own) undated.push(own.undated);
    else events.push(own);
  }
  const listInput = manifest.behaviors?.find((b) => b.use === 'upcoming-events');
  const listName = (listInput?.config as { input?: string } | undefined)?.input;
  const list = listName ? sample[listName] : undefined;
  for (const item of Array.isArray(list) ? list : []) {
    const r = row(item);
    const e = r && eventOf(r, scan?.window, undefined, zone);
    if (!e) continue;
    if ('undated' in e) {
      if (!undated.includes(e.undated)) undated.push(e.undated);
    } else if (
      e.closesAt >= now &&
      !events.some((x) => x.name === e.name && x.opensAt === e.opensAt)
    )
      events.push(e);
  }
  const rules = scan?.checkIn;
  const checkIn = rules
    ? {
        ...(rules.mode ? { mode: rules.mode } : {}),
        ...(rules.days ? { days: rules.days } : {}),
        ...(rules.durationMinutes ? { durationMinutes: rules.durationMinutes } : {}),
        ...(rules.durationFrom ? { durationFrom: rules.durationFrom } : {}),
      }
    : undefined;
  return {
    events: events.sort((a, b) => a.opensAt - b.opensAt).slice(0, MAX_EVENTS),
    undated,
    checkIn: checkIn && Object.keys(checkIn).length > 0 ? checkIn : undefined,
  };
}

function local(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ms);
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = at('weekday').toLowerCase().slice(0, 3);
  return {
    weekday: DAYS.find((d) => d === weekday) ?? 'mon',
    time: `${at('hour')}:${at('minute')}`,
  };
}
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Weekly hours that cover each event's window in the session's zone, from doors open to close.
 * Null (always open) when an event runs a day or more or the spans do not fit the schedule.
 */
export function hoursForEvents(
  windows: readonly { opensAt: number; closesAt: number }[],
  timeZone: string,
) {
  if (windows.length === 0 || windows.some((w) => w.closesAt - w.opensAt >= DAY)) return null;
  const week: Record<string, [number, number][]> = {};
  for (const w of windows) {
    const start = local(w.opensAt, timeZone);
    const end = local(w.closesAt, timeZone);
    const from = minutes(start.time);
    const to = minutes(end.time);
    week[start.weekday] = [...(week[start.weekday] ?? []), [from, to <= from ? to + 1440 : to]];
  }
  const fmt = (m: number) => {
    const t = m % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const hours: Record<string, string[]> = {};
  for (const [day, spans] of Object.entries(week)) {
    const merged: [number, number][] = [];
    for (const span of spans.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    hours[day] = merged.map(([a, b]) => `${fmt(a)}-${fmt(b)}`);
  }
  const parsed = SessionHoursSchema.safeParse(hours);
  return parsed.success ? parsed.data : null;
}
