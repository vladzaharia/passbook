/** Wall-clock <-> UTC conversion in an explicit IANA zone. */

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function zoneList(extra: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  const set = new Set(['UTC', ...zones]);
  set.add(extra);
  return [...set].sort();
}

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
