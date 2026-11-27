/** What the app is told about each read: one terminal per id, then corrections while it is on screen. */
import type { ScanOutcome, ScanState } from '../machine/types.ts';

export type ReaderOutcome = 'accepted' | 'rejected' | 'error';
export type DropReason = 'duplicate' | 'replaced' | 'closed';
/** How the page answers a native read: refuse it, follow it by input id, or end it at once. */
export type ReadResult = { error: true } | { track: string } | { drop: DropReason };

const MAX_PENDING = 8;
const MAX_ANSWERED = 8;

export const outcomeOf = (o: ScanOutcome): ReaderOutcome =>
  !o.local && o.kind === 'ok' ? 'accepted' : o.kind === 'refused' ? 'rejected' : 'error';

/** The ids the machine still owns: the read in the open slot, the parked one, the held one. */
export function liveIds(s: ScanState): Set<string> {
  const l = s.loop;
  const ids = new Set<string>();
  if ('input' in l) ids.add(l.input.id);
  if ('next' in l && l.next) ids.add(l.next.id);
  if ('held' in l && l.held) ids.add(l.held.id);
  return ids;
}

/** The read on screen with the verdict the app is owed: a verdict, or a desk card (accepted, then its band). */
export function onScreen(s: ScanState): { id: string; outcome: ReaderOutcome } | null {
  const l = s.loop;
  if (l.s === 'verdict') return { id: l.input.id, outcome: outcomeOf(l.outcome) };
  if (l.s === 'member') return { id: l.input.id, outcome: l.band ? outcomeOf(l.band) : 'accepted' };
  return null;
}

/** Why a tracked read with no answer left the machine between two states. */
export function departure(prev: ScanState, id: string): DropReason {
  const l = prev.loop;
  return ('next' in l && l.next?.id === id) || ('held' in l && l.held?.id === id)
    ? 'replaced'
    : 'closed';
}

export function createNativeSettle(send: (message: object) => void, settles: () => boolean) {
  /** Input id to native id, oldest first, until the id's one terminal is sent. */
  const pending = new Map<string, string>();
  /** Input id to what the app last heard, for ids that got a `result`. */
  const answered = new Map<string, { nativeId: string; outcome: ReaderOutcome }>();
  const sendDrop = (nativeId: string, reason: DropReason) =>
    send(
      settles()
        ? { op: 'dropped', id: nativeId, reason }
        : { op: 'result', id: nativeId, outcome: 'error' },
    );
  return {
    track(inputId: string, nativeId: string) {
      pending.set(inputId, nativeId);
      for (const oldest of pending.keys()) {
        if (pending.size <= MAX_PENDING) break;
        const id = pending.get(oldest) as string;
        pending.delete(oldest);
        sendDrop(id, 'replaced');
      }
    },
    /** `result` once, then `revise` when the outcome changes (settle only). */
    answer(inputId: string, outcome: ReaderOutcome): boolean {
      const nativeId = pending.get(inputId);
      if (nativeId !== undefined) {
        pending.delete(inputId);
        send({ op: 'result', id: nativeId, outcome });
        answered.set(inputId, { nativeId, outcome });
        for (const oldest of answered.keys()) {
          if (answered.size <= MAX_ANSWERED) break;
          answered.delete(oldest);
        }
        return true;
      }
      const prior = answered.get(inputId);
      if (!prior || prior.outcome === outcome || !settles()) return false;
      prior.outcome = outcome;
      send({ op: 'revise', id: prior.nativeId, outcome });
      return true;
    },
    /** End a tracked read that got no verdict. A dropped id is never answered or revised. */
    drop(inputId: string, reason: DropReason): boolean {
      const nativeId = pending.get(inputId);
      if (nativeId === undefined) return false;
      pending.delete(inputId);
      sendDrop(nativeId, reason);
      return true;
    },
    /** End a read the page never tracked. */
    dropNative: sendDrop,
    unanswered: (): string[] => [...pending.keys()],
    /** The ids the page is waiting on, emptied: the caller tells the machine. */
    takeAll(): string[] {
      const ids = [...pending.keys()];
      pending.clear();
      answered.clear();
      return ids;
    },
    clear() {
      pending.clear();
      answered.clear();
    },
  };
}
