/** How a session's window reads to people: clock times in the session's own zone. */
export interface WindowView {
  open: boolean;
  by: 'always' | 'hours' | 'hold';
  opensAt: number | null;
  closesAt: number | null;
}

const DAY_MS = 86_400_000;

function parts(at: number, zone: string, extra: Intl.DateTimeFormatOptions = {}) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    ...extra,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) out[p.type] = p.value;
  return out;
}

const dayNumber = (p: Record<string, string>) =>
  Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS;

export const viewerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "8:00 AM": the app's clock (lib/format.ts), in the zone. */
export function clockIn(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(at)
    .replace(/\u202f/g, ' ');
}

/**
 * "8:00 AM" today, "Tue 8:00 AM" within the week, "Nov 24, 8:00 AM" beyond. The zone's short name
 * follows when it is not the viewer's.
 */
export function whenIn(
  at: number,
  zone: string,
  now: number,
  viewer: string = viewerZone(),
): string {
  const p = parts(at, zone);
  const days = dayNumber(p) - dayNumber(parts(now, zone));
  const time = clockIn(at, zone);
  let text = time;
  if (days >= 1 && days <= 6) text = `${p.weekday} ${time}`;
  else if (days < 0 || days > 6)
    text = `${parts(at, zone, { month: 'short' }).month} ${p.day}, ${time}`;
  if (zone !== viewer) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((x) => x.type === 'timeZoneName')?.value;
    if (name) text += ` ${name}`;
  }
  return text;
}

/** The pill's sub-label; null when there is nothing to add (always open). */
export function windowLabel(
  w: WindowView,
  zone: string,
  now: number,
  viewer: string = viewerZone(),
): string | null {
  if (w.open) {
    if (w.closesAt === null) return null;
    return `${w.by === 'hold' ? 'Held open' : 'Open'} until ${whenIn(w.closesAt, zone, now, viewer)}`;
  }
  if (w.opensAt === null) return w.by === 'hold' ? 'Closed by hand' : 'No opening set';
  const when = whenIn(w.opensAt, zone, now, viewer);
  return w.by === 'hold' ? `Closed until ${when}` : `Opens ${when}`;
}

/** The next instant the window changes: when to look again. */
export const nextEdge = (w: WindowView): number | null => (w.open ? w.closesAt : w.opensAt);
