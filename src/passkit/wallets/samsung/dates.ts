/** Start and end dates, the next event of a multi-event pass, and the losses around them. */

import type { ViewEvent, WalletRole } from '../types.ts';
import { note, type Run } from './context.ts';
import { epochMs, epochText } from './format.ts';

const isoOf = (run: Run, role: WalletRole): string | undefined => {
  const value = run.view.roles[role];
  return value?.kind === 'date' ? value.iso : undefined;
};

/** The next event of a multi-event pass: the first not yet started, else the last. */
function nextEvent(run: Run): ViewEvent | undefined {
  const dated = run.view.events.filter((e) => epochMs(e.date) !== undefined);
  if (run.view.events.length < 2 || dated.length === 0) return undefined;
  const now = run.opts.now.getTime();
  return dated.find((e) => (epochMs(e.date) as number) >= now) ?? dated[dated.length - 1];
}

/**
 * `startDate` and `endDate`. A multi-event pass shows its next event only; its end is the matching
 * relevant date range. The role lists give the start and the end, best first.
 */
export function eventWindow(
  run: Run,
  startRoles: readonly WalletRole[],
  endRoles: readonly WalletRole[],
  multi = true,
): { start?: string; end?: string } {
  const { view } = run;
  if (!multi && view.events.length > 1)
    note(run, 'upcoming.multi', 'events', 'omitted', 'Samsung coupons show one date only.');
  const next = multi ? nextEvent(run) : undefined;
  if (next?.date) {
    note(run, 'upcoming.multi', 'events', 'difference', 'Samsung shows the next event only.');
    const at = epochMs(next.date);
    const range = view.relevance.dates.find((d) => epochMs(d.start) === at);
    const first = startRoles.map((r) => isoOf(run, r)).find((v) => v !== undefined);
    const end = range?.end ?? (epochMs(first) === at ? isoOf(run, 'eventEnd') : undefined);
    return { start: next.date, ...(end ? { end } : {}) };
  }
  if (view.relevance.dates.length > 1)
    note(run, 'relevance.dates', 'relevantDates', 'difference', 'Samsung carries one start date.');
  const start = startRoles.map((r) => isoOf(run, r)).find((v) => v !== undefined);
  const end = endRoles.map((r) => isoOf(run, r)).find((v) => v !== undefined);
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

export function setWindow(run: Run, window: { start?: string; end?: string }): void {
  const start = epochText(window.start);
  const end = epochText(window.end);
  if (start) run.attrs.startDate = start;
  if (end) run.attrs.endDate = end;
}

/** Losses every type shares: what Samsung has no place for at all. */
export function noteLosses(run: Run): void {
  const { view } = run;
  if (view.relevance.beacons.length > 0)
    note(run, 'relevance.beacons', 'beacons', 'unsupported', 'Samsung has no beacons.');
  if (view.relevance.maxDistance !== undefined)
    note(run, 'relevance.maxDistance', '', 'unsupported', 'Samsung has no distance limit.');
  if (view.nfc) note(run, 'nfc', '', 'unsupported', 'Samsung passes carry no NFC payload here.');
  if (view.personalization)
    note(run, 'personalization', '', 'unsupported', 'Samsung has no sign-up personalization.');
  if (view.sharingProhibited)
    note(run, 'sharing', '', 'omitted', 'Samsung sharing is not restricted.');
  if (view.messaging.fields.length > 0)
    note(
      run,
      'messaging.notify',
      '',
      'difference',
      'The change text is written in the notice; Samsung decides what the holder is told.',
    );
  if (
    view.roles.redemptionChannel?.kind === 'channel' &&
    view.roles.redemptionChannel.channel !== 'both'
  )
    note(
      run,
      'role.redemptionChannel',
      '',
      'unsupported',
      'Samsung does not show where an offer is used.',
    );
  if (run.type !== 'ticket' && view.roles.eventId)
    note(run, 'role.eventId', '', 'unsupported', 'The event id is used by tickets only.');
}
