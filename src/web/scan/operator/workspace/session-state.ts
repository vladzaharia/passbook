/** What the top bar says about the session: open or closed, what it admits, how full it is. */

import type { ScanCounts } from '../../../../shared/contracts/scan.ts';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { formatWeekdayTime } from '../../../lib/format.ts';
import { sessionTime } from '../../ui/session-time.ts';

const T = OPERATOR_COPY.top;

export interface SessionChip {
  open: boolean;
  text: string;
  /** When a closed session opens again. */
  sub: string | null;
}

export function sessionChip(session: ScanSession): SessionChip {
  const window = session.workspace?.session.window;
  const zone = session.workspace?.session.timeZone ?? session.scanner?.timeZone;
  const closed =
    session.state === 'closed' || session.state === 'not_open' || window?.open === false;
  if (closed) {
    const opens = window?.opensAt ?? session.event?.opensAt ?? null;
    return {
      open: false,
      text: OPERATOR_COPY.idle.closed,
      sub:
        opens && zone
          ? OPERATOR_COPY.idle.reopens.replace('{when}', formatWeekdayTime(opens, zone))
          : null,
    };
  }
  const closes = window?.closesAt ?? session.event?.closesAt ?? null;
  return {
    open: true,
    text: closes ? T.open.replace('{time}', sessionTime(closes, zone)) : 'Open',
    sub: null,
  };
}

/** The types the session admits, by name. */
export function admitNames(session: ScanSession): string[] {
  return session.templates.map((t) => t.name);
}

export interface InNow {
  count: number;
  capacity: number | null;
  /** 0 to 1 of capacity. */
  ratio: number | null;
}

/** People in now for an event or a zone; null for a session that counts visits only. */
export function inNowOf(counts: ScanCounts): InNow | null {
  const place = counts.place;
  if (place)
    return {
      count: place.inNow,
      capacity: place.capacity,
      ratio: ratioOf(place.inNow, place.capacity),
    };
  const event = counts.event;
  if (event && event.inside !== null)
    return {
      count: event.inside,
      capacity: event.capacity,
      ratio: ratioOf(event.inside, event.capacity),
    };
  return null;
}

const ratioOf = (count: number, capacity: number | null) =>
  capacity ? Math.min(1, count / capacity) : null;
