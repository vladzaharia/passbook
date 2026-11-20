import type { Visitor, VisitorStatus } from '@/shared/contracts/visitors.ts';
import { VISITOR_COPY } from '@/shared/copy/visitors.ts';
import type { ConfirmCopy } from './confirms.ts';
import { formatShortDate, formatTime } from './format.ts';
import type { Tone } from './status.ts';

/** "Nov 25, 9:00 AM – 5:00 PM", or both days when the visit crosses midnight. */
export function whenLine(from: number, until: number): string {
  return formatShortDate(from) === formatShortDate(until)
    ? `${formatShortDate(from)}, ${formatTime(from)} – ${formatTime(until)}`
    : `${formatShortDate(from)}, ${formatTime(from)} – ${formatShortDate(until)}, ${formatTime(until)}`;
}

export const STATUS_TONE: Record<VisitorStatus, Tone> = {
  expected: 'info',
  in: 'success',
  out: 'neutral',
  no_show: 'neutral',
  cancelled: 'neutral',
};

/** "Checked in 9:12 AM" once there is a time to give. */
export function statusLine(v: Pick<Visitor, 'status' | 'statusAt'>): string {
  const base = VISITOR_COPY.status[v.status];
  return (v.status === 'in' || v.status === 'out') && v.statusAt !== null
    ? `${base} ${formatTime(v.statusAt)}`
    : base;
}

/** The viewer's local day: Today follows their clock, not the server's. */
export function localDay(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  return { start: new Date(y, m, d).getTime(), end: new Date(y, m, d + 1).getTime() };
}

/** Cancelling an invited visit voids the visitor's pass. */
export function cancelVisitConfirm(name: string): ConfirmCopy {
  return {
    title: `Cancel ${name}'s visit?`,
    confirmLabel: 'Cancel visit',
    description: 'Their pass is voided. They are not told.',
    typed: false,
    cancelLabel: 'Keep visit',
  };
}
