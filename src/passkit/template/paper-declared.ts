/** What the template itself says about its times and check-in, for the ticket's start, end and one-use line. */
import type { Personalization, TemplateManifest } from '../types.ts';
import { isUtcClock, paperZoneOf } from './paper-format.ts';
import { ISO } from './paper-kinds-base.ts';

type Manifest = Pick<TemplateManifest, 'behaviors' | 'scan'>;
const plain = (v: unknown): string | undefined =>
  typeof v === 'string' || typeof v === 'number' ? String(v).trim() || undefined : undefined;

/** Every check-in action admits once: only then does the print say "once". */
export function checkInOnce(manifest: Manifest): boolean {
  const actions = (
    (manifest.scan as { actions?: { kind?: string; repeat?: string }[] } | undefined)?.actions ?? []
  ).filter((a) => a.kind === 'check_in');
  return actions.length > 0 && actions.every((a) => a.repeat === 'once');
}

const START_INPUTS = ['startsAt', 'departsAt', 'checkIn'];
/** Inputs that are a validity, never a start: they print as "Use by" and the range. */
const VALIDITY_INPUTS = new Set(['validFrom', 'validUntil', 'validTo', 'expires', 'collectBy']);
const END_INPUTS = ['endsAt', 'checkOut'];

/**
 * The start and end the author's inputs name. Arrival is left out (it is in another zone) and so
 * is `validUntil`, which paper prints as the validity. A `relevance-window` start input covers other names,
 * unless it names a validity input.
 */
export function declaredTimes(manifest: Manifest, personalization: Personalization) {
  const window = manifest.behaviors?.find((b) => b.use === 'relevance-window')?.config as
    | { start?: unknown }
    | undefined;
  const read = (names: (string | unknown)[]) => {
    for (const n of names) {
      const v =
        typeof n === 'string' && !VALIDITY_INPUTS.has(n) ? plain(personalization[n]) : undefined;
      if (v && ISO.test(v)) return v;
    }
    return undefined;
  };
  return { start: read([...START_INPUTS, window?.start]), end: read(END_INPUTS) };
}

/**
 * The zone times print in. A named zone (the template's zone input) wins; a time written in UTC
 * with a clock reads in the org's zone; otherwise every time keeps its own offset.
 */
export function printZone(
  times: (string | undefined)[],
  named: string | undefined,
  orgZone: string | null | undefined,
): { zone?: string; zoneNamed: boolean } {
  const ref = times.find(Boolean);
  const own = paperZoneOf(ref, named);
  if (named && own === named) return { zone: own, zoneNamed: true };
  if (orgZone && isUtcClock(ref) && paperZoneOf(undefined, orgZone) === orgZone)
    return { zone: orgZone, zoneNamed: true };
  return { ...(own ? { zone: own } : {}), zoneNamed: false };
}
