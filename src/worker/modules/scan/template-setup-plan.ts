import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { PlainLineSchema } from '../../../shared/contracts/common.ts';
import type { ScannerSettings } from '../../../shared/contracts/scan.ts';
import { TimeZoneSchema } from '../../../shared/contracts/scan-base.ts';

const MINUTE = 60_000;
/** An event with a start and no end counts as running this long (as in the upcoming-events behavior). */
const FALLBACK_MINUTES = 180;
/** A session admits at most this many events (AdmitsSchema). */
export const MAX_EVENTS = 10;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Which per-pass inputs of a template describe the event its passes are for. */
export interface EventSource {
  own: {
    name: string;
    start: string;
    end: string | null;
    doors: string | null;
    venueName: string | null;
    venueRegion: string | null;
    zone: string | null;
    /** A per-slot input (a timed ticket's `slotKey`): matches one slot's passes exactly. */
    slot: string | null;
  } | null;
  /** The upcoming-events list input. */
  list: string | null;
  early: number;
  late: number;
}

export interface PlannedEvent {
  /** One live event per template, start and name. */
  key: string;
  name: string;
  opensAt: number;
  closesAt: number;
  timeZone: string | null;
  venue: string | null;
  /** The pass input and value that tell this event's passes from the template's others, if one does. */
  match: { input: string; value: string } | null;
}

/** An event's values as a pass holds them: its own inputs, or one entry of its upcoming-events list. */
export interface EventValues {
  name?: Json;
  startsAt?: Json;
  endsAt?: Json;
  doorsAt?: Json;
  venueName?: Json;
  venueRegion?: Json;
  timeZone?: Json;
  slot?: Json;
  /** Read from the pass's own inputs (not a list entry), so the name input can match passes. */
  own?: boolean;
}

const isInput = (manifest: TemplateManifest, name: string | undefined): name is string =>
  name !== undefined &&
  INPUT_NAME.test(name) &&
  Object.hasOwn(manifest.inputs.properties ?? {}, name);

/** A line of display text from data a person typed: no controls or bidi marks, cut by characters. */
export function plainText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const spaced = Array.from(value.normalize(), (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    const bad =
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069);
    return bad ? ' ' : ch;
  });
  const cut = spaced.join('').replace(/\s+/g, ' ').trim();
  const text = Array.from(cut).slice(0, max).join('').trim();
  return PlainLineSchema(max).safeParse(text).success ? text : null;
}

/**
 * The inputs that hold a pass's event. Event data is per pass (a ticket names its own event), so it
 * is read from issued passes, never from the template's sample, which is only a preview.
 */
export function eventSource(manifest: TemplateManifest): EventSource {
  const window = manifest.scan?.window;
  const pick = (...names: (string | undefined)[]) =>
    names.find((n) => isInput(manifest, n)) ?? null;
  const name = pick('eventName');
  const start = pick(window?.from, 'startsAt');
  const listConfig = manifest.behaviors?.find((b) => b.use === 'upcoming-events')?.config as
    | { input?: string }
    | undefined;
  return {
    own:
      name && start
        ? {
            name,
            start,
            end: pick(window?.until, 'endsAt'),
            doors: pick('doorsAt'),
            venueName: pick('venueName'),
            venueRegion: pick('venueRegion'),
            zone: pick('venueTimeZone'),
            slot: pick('slotKey'),
          }
        : null,
    list: pick(listConfig?.input),
    early: window?.earlyMinutes ?? 0,
    late: window?.lateMinutes ?? 0,
  };
}

const instant = (v: Json | undefined): number | undefined => {
  const ms = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * Upcoming or running events from what issued passes hold: distinct by start and name, soonest
 * first, at most `MAX_EVENTS` (`more`: others were left out). Past events are never planned.
 */
export function planEvents(
  templateId: string,
  source: EventSource,
  values: readonly EventValues[],
  now: number,
): { events: PlannedEvent[]; more: boolean } {
  const seen = new Map<string, PlannedEvent & { raw: string | null }>();
  // A name that several starts share (slots of one show) cannot tell their passes apart.
  const starts = new Map<string, Set<number>>();
  for (const v of values) {
    const name = plainText(v.name, 80);
    const start = instant(v.startsAt);
    if (!name || start === undefined) continue;
    const key = `${templateId}|${start}|${name}`;
    if (seen.has(key)) continue;
    const end = instant(v.endsAt);
    const doors = instant(v.doorsAt);
    const venue = [plainText(v.venueName, 80), plainText(v.venueRegion, 80)]
      .filter(Boolean)
      .join(', ');
    const zone = TimeZoneSchema.safeParse(v.timeZone);
    const closesAt =
      (end !== undefined && end > start ? end : start + FALLBACK_MINUTES * MINUTE) +
      source.late * MINUTE;
    if (closesAt < now) continue;
    const slot = v.own && source.own?.slot ? plainText(v.slot, 120) : null;
    starts.set(name, (starts.get(name) ?? new Set()).add(start));
    seen.set(key, {
      key,
      name,
      opensAt: doors !== undefined && doors < start ? doors : start - source.early * MINUTE,
      closesAt,
      timeZone: zone.success ? zone.data : null,
      venue: plainText(venue, 140),
      match: slot && source.own?.slot ? { input: source.own.slot, value: slot } : null,
      raw: v.own && v.name === name ? name : null,
    });
  }
  const all = [...seen.values()].sort((a, b) => a.opensAt - b.opensAt);
  const events = all.slice(0, MAX_EVENTS).map(({ raw, ...e }) => ({
    ...e,
    match:
      e.match ??
      (raw !== null && source.own && (starts.get(raw)?.size ?? 0) === 1
        ? { input: source.own.name, value: raw }
        : null),
  }));
  return { events, more: all.length > MAX_EVENTS };
}

/** The pass type's own check-in rules, as the session's default for it. */
export function checkInOf(manifest: TemplateManifest): ScannerSettings['checkIn'] | undefined {
  const rules = manifest.scan?.checkIn;
  if (!rules) return undefined;
  const checkIn = {
    ...(rules.mode ? { mode: rules.mode } : {}),
    ...(rules.days ? { days: rules.days } : {}),
    ...(rules.durationMinutes ? { durationMinutes: rules.durationMinutes } : {}),
    ...(rules.durationFrom ? { durationFrom: rules.durationFrom } : {}),
  };
  return Object.keys(checkIn).length > 0 ? checkIn : undefined;
}
