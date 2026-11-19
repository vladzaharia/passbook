import { SCAN_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { formatTime } from '../../lib/format.ts';
import { isExit } from './access-view.ts';
import type { ScanOutcome } from './types.ts';

const DAY = 86_400_000;

/** "Day pass · until 11:59 PM", "Guest · visit 2 of 3", an event's name. Null from a server without `admit`. */
export function admitLine(o: ScanOutcome): string | null {
  const a = o.admit;
  if (!a || o.kind !== 'ok' || o.action?.id === 'undo' || isExit(o)) return null;
  const c = SCAN_COPY.verdict.admit;
  const r = a.rule;
  if (r?.kind === 'event') return r.name;
  const rule = !r
    ? null
    : r.kind === 'until'
      ? // The end is exclusive; a month-long pass says nothing about it.
        r.at - (o.at ?? 0) <= DAY
        ? scanLine(c.until, { time: formatTime(r.at - 1, a.timeZone) })
        : null
      : r.kind === 'visit'
        ? r.of === null
          ? null
          : scanLine(c.visit, { n: r.n, of: r.of })
        : r.kind === 'left'
          ? scanLine(c.left, { n: r.n })
          : c[r.kind];
  return rule ? scanLine(c.line, { type: a.type, rule }) : a.type;
}
