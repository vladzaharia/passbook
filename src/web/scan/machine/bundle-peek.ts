/**
 * Which bundle stands behind a check-in. The door's auto flow acts at once and the act answer does not
 * carry the bundle (the act path is held to its round-trip budget), so after an ok verdict the door
 * asks `resolve` for the same pass. The answer arrives as a `bundle` event: the card gets its group
 * row, the dock its "Check in N more", and the verdict waits for the tap. Like the assign loop's
 * events, these sit beside the frozen `types.ts`.
 */
import type { ScanInput } from '../input/types.ts';
import type { MachineEvent } from './access-events.ts';
import { groupAction } from './group-view.ts';
import type { MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { GROUP_HOLD } from './present.ts';
import type { Cmd, ScanOutcome } from './types.ts';

export type BundleEvent = {
  type: 'bundle';
  scanId: string;
  bundle: NonNullable<ScanOutcome['bundle']>;
};
export type BundleCmd = { c: 'bundle'; key: string; scanId: string; input: ScanInput };

export const isBundleEvent = (event: MachineEvent): event is BundleEvent => event.type === 'bundle';
export const isBundleCmd = (cmd: Cmd): cmd is Cmd & BundleCmd =>
  (cmd as { c: string }).c === 'bundle';
export const bundleCmd = (cmd: BundleCmd): Cmd => cmd as unknown as Cmd;

/** An ok door verdict that has not said whether a bundle stands behind it. */
export const wantsPeek = (s: MachineState, o: ScanOutcome): boolean =>
  s.posture === 'door' &&
  s.online &&
  o.kind === 'ok' &&
  !o.local &&
  !o.bundle &&
  !o.group &&
  o.scanId !== null;

/** The bundle arrived for the verdict on screen: show it, and hold the verdict while people are left. */
export function bundleKnown(s: MachineState, ev: BundleEvent, now: number): Out {
  const l = s.loop;
  if (l.s !== 'verdict' || l.outcome.scanId !== ev.scanId || l.outcome.bundle) return same(s);
  const outcome = { ...l.outcome, bundle: ev.bundle };
  const wait = groupAction(outcome) && l.closeAt !== null;
  return out({
    ...s,
    loop: { ...l, outcome, closeAt: wait ? Math.max(l.closeAt ?? 0, now + GROUP_HOLD) : l.closeAt },
    recent: s.recent.map((r) => (r.scanId === ev.scanId ? { ...r, outcome } : r)),
  });
}
