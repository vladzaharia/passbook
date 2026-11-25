import { DEFAULT_EVENT_MINUTES, listedEventTimes } from '../../boundaries.ts';
import { normalizePass } from '../../schema/normalize.ts';
import type { BehaviorContext, PassJson, Personalization } from '../../types.ts';
import {
  eventWindows,
  listEvents,
  schedule,
  type UpcomingEventsConfig,
  writeEvents,
} from './index.ts';

/** The pass.json keys the clock moves (docs/design/event-boundaries.md). Every other key stays as built. */
export const TIMED_KEYS = [
  'upcomingPassInformation',
  'relevantDates',
  'relevantDate',
  'expirationDate',
] as const;

/** The timed keys of a pass; a key left out is absent from it. */
export type TimedKeys = Partial<Pick<PassJson, (typeof TIMED_KEYS)[number]>>;

export function timedKeysOf(pass: PassJson): TimedKeys {
  const out: Record<string, unknown> = {};
  for (const key of TIMED_KEYS) if (pass[key] !== undefined) out[key] = pass[key];
  return out as TimedKeys;
}

const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
        )
      : v;

/** True when both carry the same timed keys, whatever the key order. */
export function sameTimedKeys(a: TimedKeys, b: TimedKeys): boolean {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

/** `pass` with its timed keys replaced by `keys`. */
export function withTimedKeys(pass: PassJson, keys: TimedKeys): PassJson {
  const out = { ...pass } as Record<string, unknown>;
  for (const key of TIMED_KEYS) delete out[key];
  return { ...out, ...keys } as PassJson;
}

const sameWindow = (a: { startDate?: string; endDate?: string }, b: typeof a) =>
  Date.parse(a.startDate ?? '') === Date.parse(b.startDate ?? '') &&
  Date.parse(a.endDate ?? '') === Date.parse(b.endDate ?? '');

/**
 * A pass the behavior built earlier, as it would build it at `at`: the events listed then, the
 * active mark, and with `schedule` their relevance windows, `relevantDate` and the expiry. The
 * events come from `input`, so one beyond the cap moves up when an earlier one ends. The windows,
 * date and expiry the events added at build time are taken back first, so the pass's own stay. The
 * one guess: a `relevantDate` equal to the first listed start follows the first listed event. The
 * expiry never moves earlier.
 */
export function retimePass(
  built: PassJson,
  input: Personalization,
  config: UpcomingEventsConfig,
  lookups: BehaviorContext['lookups'],
  at: number,
): PassJson {
  const pass = structuredClone(built);
  const list = listEvents(input, config, lookups, at);
  if (list === null) {
    delete pass.upcomingPassInformation;
    return normalizePass(pass);
  }
  if (config.schedule) {
    const lead = config.schedule.leadMinutes ?? 0;
    const fallbackMinutes = config.fallbackMinutes ?? DEFAULT_EVENT_MINUTES;
    const before = listedEventTimes(built, { fallbackMinutes });
    const added = eventWindows(before, lead);
    const own = (pass.relevantDates ?? []).filter((w) => !added.some((a) => sameWindow(w, a)));
    if (own.length > 0) pass.relevantDates = own;
    else delete pass.relevantDates;
    const first = before.find((e) => e.start !== undefined)?.start;
    if (list.length > 0 && first !== undefined && Date.parse(pass.relevantDate ?? '') === first)
      delete pass.relevantDate;
    writeEvents(pass, list);
    if (list.length > 0) schedule(pass, list, lead);
    else {
      // With every event over the expiry stays after the last one, as the last render had it.
      const all = listEvents(input, config, lookups, Number.NEGATIVE_INFINITY, Infinity) ?? [];
      const last = Math.max(...all.flatMap((e) => (e.until === undefined ? [] : [e.until])));
      if (Number.isFinite(last) && !(Date.parse(pass.expirationDate ?? '') >= last))
        pass.expirationDate = new Date(last).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  } else writeEvents(pass, list);
  return normalizePass(pass);
}
