/** Wall-clock <-> UTC conversion in an explicit IANA zone. */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function wallAsUtc(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
}

/** `YYYY-MM-DDTHH:mm` as read in `zone` to a UTC ISO string; undefined when unparsable. */
export function localToIso(local: string, zone: string): string | undefined {
  const m = LOCAL.exec(local);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    let ms = guess - (wallAsUtc(guess, zone) - guess);
    ms = guess - (wallAsUtc(ms, zone) - ms);
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

/** A stored instant as `YYYY-MM-DDTHH:mm` in `zone`; empty when unparsable. */
export function isoToLocal(iso: string, zone: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  try {
    return new Date(wallAsUtc(ms, zone)).toISOString().slice(0, 16);
  } catch {
    return '';
  }
}

/** Minutes east of UTC that `zone` uses at `ms`. */
export function zoneOffset(ms: number, zone: string): number {
  return Math.round((wallAsUtc(ms, zone) - Math.floor(ms / 1000) * 1000) / 60_000);
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');

/**
 * `YYYY-MM-DDTHH:mm` read in `zone` as ISO with that zone's offset ("2030-06-01T08:00:00-07:00"),
 * so Wallet shows the local time with ignoresTimeZone. Undefined when unparsable.
 */
export function localToOffsetIso(local: string, zone: string): string | undefined {
  const utc = localToIso(local, zone);
  if (!utc) return undefined;
  const ms = Date.parse(utc);
  const off = zoneOffset(ms, zone);
  const wall = new Date(ms + off * 60_000).toISOString().slice(0, 19);
  return `${wall}${off < 0 ? '-' : '+'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

const OFFSET = /([+-])(\d{2}):?(\d{2})$/;
/** The offset (minutes) written in an ISO string, or undefined for Z or none. */
export function writtenOffset(iso: string): number | undefined {
  const m = OFFSET.exec(iso);
  if (!m) return undefined;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
