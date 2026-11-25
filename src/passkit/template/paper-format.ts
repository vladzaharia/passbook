/**
 * Dates on paper. Content carries ISO times and a zone; the page and the PDF format them here so
 * every time prints with its zone abbreviation and the two renderers cannot differ.
 */

/** English locales that name their zones (`NZDT`, `AEST`); `en-US` only names the American ones. */
const ZONE_LOCALES = ['en-US', 'en-GB', 'en-NZ', 'en-AU', 'en-CA', 'en-IN', 'en-ZA', 'en-IE'];
const OFFSET = /(?:Z|([+-])(\d{2}):?(\d{2}))$/;

/** The zone a written time carries: an IANA name from the template, else the offset in the ISO text. */
export function paperZoneOf(iso: string | undefined, named?: string): string | undefined {
  if (named) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: named });
      return named;
    } catch {
      // Not a zone name: use the offset the time itself carries.
    }
  }
  const m = iso ? OFFSET.exec(iso) : null;
  if (!m) return undefined;
  return m[1] ? `${m[1]}${m[2]}:${m[3]}` : 'UTC';
}

/** The zone to print one time in: the template's named zone, else the offset that time carries. */
export function paperZoneFor(
  c: { zone?: string | undefined; zoneNamed?: boolean },
  iso: string,
): string | undefined {
  return c.zoneNamed ? c.zone : paperZoneOf(iso);
}

/** A time written in UTC with a clock (not a bare date): it needs a zone of the org to read. */
export const isUtcClock = (iso: string | undefined): boolean =>
  Boolean(iso) && /Z$/.test(iso as string) && !/T00:00:00(?:\.0+)?Z$/.test(iso as string);

function zoneName(zone: string, at: Date, style: 'short' | 'longGeneric'): string | undefined {
  let fallback: string | undefined;
  for (const locale of ZONE_LOCALES) {
    const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (!part) continue;
    fallback ??= part;
    if (!/^GMT[+-]|^UTC[+-]/.test(part)) return part;
  }
  return fallback;
}

/** `NZDT` for the zone at that time, and "New Zealand Time" when the zone has a name. */
export function paperZoneInfo(
  zone: string,
  iso: string,
): { abbr: string; name?: string } | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const abbr = zoneName(zone, at, 'short');
  if (!abbr) return undefined;
  const name = zoneName(zone, at, 'longGeneric');
  return { abbr, ...(name && !/^GMT|^UTC/.test(name) ? { name } : {}) };
}

export type PaperDateStyle = 'long' | 'short' | 'time' | 'timeZone' | 'stamp';

const lower = (s: string) => s.replace(/\s?([AP])M\b/g, (_, c: string) => ` ${c.toLowerCase()}m`);

/**
 * One date or time. `long`: Saturday 13 February 2027. `short`: Sat 13 Feb 2027. `time`: 7:30 pm.
 * `timeZone`: 7:30 pm NZDT. `stamp`: 19 Nov 2026, 2:02 pm NZDT.
 */
export function paperDate(iso: string, zone: string | undefined, style: PaperDateStyle): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const base = { timeZone: zone ?? 'UTC' };
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...base, ...o });
  const abbr = zone ? paperZoneInfo(zone, iso)?.abbr : undefined;
  const clock = () =>
    lower(
      new Intl.DateTimeFormat('en-US', { ...base, hour: 'numeric', minute: '2-digit' }).format(at),
    );
  const tail = abbr ? ` ${abbr}` : '';
  if (style === 'long')
    return fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      .format(at)
      .replace(',', '');
  if (style === 'short')
    return fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      .format(at)
      .replace(',', '');
  if (style === 'time') return clock();
  if (style === 'timeZone') return `${clock()}${tail}`;
  return `${fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(at)}, ${clock()}${tail}`;
}
