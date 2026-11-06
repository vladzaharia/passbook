/** Every timed transition of the machine, as data (AC 3.4). Pure. */
import { SCAN_TIMING } from '../timing.ts';
import type { MachineState } from './internal.ts';

export type DeadlineKind =
  | 'card'
  | 'hint'
  | 'idle'
  | 'release'
  | 'reader'
  | 'slow'
  | 'timeout'
  | 'settle'
  | 'close'
  | 'open'
  | 'clear'
  | 'unsure';

export interface Deadline {
  kind: DeadlineKind;
  at: number;
  /** `unsure`: the entry's key. */
  key?: string;
}

/**
 * All pending deadlines. A `reader` deadline only changes what the view derives, so it is listed only
 * while it is still ahead; every other kind stays listed until its handler has run.
 */
export function deadlines(s: MachineState, now: number): Deadline[] {
  const out: Deadline[] = [];
  const l = s.loop;
  const cardAt = s.cardAt ?? 0;
  if (s.card?.phase === 'rising') out.push({ kind: 'card', at: cardAt + SCAN_TIMING.CARD_RISE });
  if (s.card?.phase === 'tucking') out.push({ kind: 'card', at: cardAt + SCAN_TIMING.CARD_TUCK });
  for (const u of s.unsure)
    if (u.state === 'retrying')
      out.push({ kind: 'unsure', at: u.at + SCAN_TIMING.UNSURE_RETRY_WINDOW, key: u.key });
  if (s.block) return out;

  switch (l.s) {
    case 'ready': {
      const live = s.camera === 'live' && s.overlay === null;
      if (live && l.hint < 3) {
        const at = l.since + SCAN_TIMING.HINT_AFTER + SCAN_TIMING.HINT_STEP * l.hint;
        if (at - s.lastActivity < SCAN_TIMING.HINT_ACTIVE_WINDOW) out.push({ kind: 'hint', at });
      }
      if (s.camera === 'live' && !(s.layout === 'stand' && s.slowed))
        out.push({ kind: 'idle', at: s.lastActivity + SCAN_TIMING.IDLE_PAUSE });
      if (s.reader.kind !== 'none') {
        const at = Math.max(s.lastActivity, s.reader.lastAt ?? 0) + SCAN_TIMING.READER_NO_READ_HINT;
        if (at > now) out.push({ kind: 'reader', at });
      }
      break;
    }
    case 'paused':
      if (!s.released && s.pausedAt !== undefined)
        out.push({ kind: 'release', at: s.pausedAt + SCAN_TIMING.STREAM_RELEASE });
      break;
    case 'checking':
    case 'applying':
      if (!l.slow) out.push({ kind: 'slow', at: l.since + SCAN_TIMING.SPINNER_DELAY });
      out.push({ kind: 'timeout', at: l.since + SCAN_TIMING.LOOKUP_TIMEOUT });
      break;
    case 'verdict':
      if (l.settleAt !== null) out.push({ kind: 'settle', at: l.settleAt });
      if (l.closeAt !== null) out.push({ kind: 'close', at: l.closeAt });
      if (l.next) out.push({ kind: 'open', at: l.openFrom });
      break;
    case 'member':
      if (!l.picker && !s.prefs.holdResults)
        out.push({ kind: 'clear', at: s.lastActivity + SCAN_TIMING.CARD_IDLE_CLEAR });
      break;
    default:
      break;
  }
  return out;
}

export function nextDeadline(s: MachineState, now: number): number | null {
  const all = deadlines(s, now);
  return all.length === 0 ? null : Math.min(...all.map((d) => d.at));
}
