/** Readers every ticket text shares: dates in the pass's zone, joins and the small shapes. */
import type { PaperContent } from '../../passkit/template/paper-content.ts';
import { paperDate, paperZoneFor, paperZoneInfo } from '../../passkit/template/paper-format.ts';

export interface Issued {
  generation: number;
  /** ISO time the print was made. */
  at?: string;
}

export interface Line {
  big?: boolean;
  text: string;
}
export interface Column {
  title: string;
  strong?: string;
  lines?: string[];
  list?: string[];
  boxes?: boolean;
}

export const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');
export const at = (
  c: PaperContent,
  iso: string | undefined,
  style: Parameters<typeof paperDate>[2],
) => (iso ? paperDate(iso, paperZoneFor(c, iso), style) : '');
export const abbrAt = (c: PaperContent, iso: string) => {
  const zone = paperZoneFor(c, iso);
  return zone ? paperZoneInfo(zone, iso)?.abbr : undefined;
};
/** The end's clock: its day when it is another day, its own zone when that differs from the start's. */
export const endAt = (c: PaperContent, end: string) => {
  const clock =
    c.start && at(c, end, 'long') !== at(c, c.start, 'long')
      ? `${at(c, end, 'short')}, ${at(c, end, 'time')}`
      : at(c, end, 'time');
  const own = abbrAt(c, end);
  return own && c.start && own !== abbrAt(c, c.start) ? `${clock} ${own}` : clock;
};
export const zoneAbbr = (c: PaperContent) => {
  const iso = c.start ?? c.validUntil;
  return c.zone && iso ? paperZoneInfo(c.zone, iso)?.abbr : undefined;
};

/** Up to two capitals for the tile that stands in for a missing photo. */
export function initialsOf(name: string | undefined): string {
  const words = (name ?? '')
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w) && !/^(?:jr|sr|ii|iii|iv)\.?$/i.test(w));
  const pick = words.length > 1 ? [words[0], words.at(-1)] : words.slice(0, 1);
  return pick.map((w) => ((w ?? '').match(/\p{L}/u)?.[0] ?? '').toUpperCase()).join('');
}

/** A clock in its own zone, with the zone's name when it differs from the start's (a checkout after the clocks change). */
export const clockAt = (c: PaperContent, iso: string): string => {
  const own = abbrAt(c, iso);
  return own && c.start && own !== abbrAt(c, c.start)
    ? `${at(c, iso, 'time')} ${own}`
    : at(c, iso, 'time');
};

/** The start and the end read in different zones: each carries its own abbreviation. */
export const splitZones = (c: PaperContent) =>
  Boolean(c.start && c.end && abbrAt(c, c.start) !== abbrAt(c, c.end));
export const startAt = (c: PaperContent, start: string) =>
  splitZones(c) ? at(c, start, 'timeZone') : at(c, start, 'time');
