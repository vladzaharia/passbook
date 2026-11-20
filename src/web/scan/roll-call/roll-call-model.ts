import type {
  RollCall,
  RollCallPerson,
  RollCallStatus,
} from '../../../shared/contracts/scan-roll-call.ts';

export interface QueuedMark {
  passId: string;
  status: RollCallStatus;
  /** The device's time of the tap: the server keeps the later of two marks. */
  at: number;
}

/** The server's call with this device's unsynced taps laid over it, so a tap shows at once and offline. */
export function withQueue(call: RollCall, queue: readonly QueuedMark[], by: string): RollCall {
  if (queue.length === 0) return call;
  const latest = new Map<string, QueuedMark>();
  for (const m of queue) {
    const held = latest.get(m.passId);
    if (!held || m.at >= held.at) latest.set(m.passId, m);
  }
  const people = call.people.map((p): RollCallPerson => {
    const m = latest.get(p.passId);
    if (!m || (p.mark && p.mark.at > m.at)) return p;
    const mark = m.status === 'none' ? null : { status: m.status, by, at: m.at };
    return { ...p, mark, notConfirmedOut: p.presence === 'lapsed' && !mark };
  });
  return { ...call, people, counts: recount(call, people) };
}

export function recount(call: RollCall, people: readonly RollCallPerson[]): RollCall['counts'] {
  const n = (f: (p: RollCallPerson) => boolean) => people.filter(f).length;
  return {
    ...call.counts,
    present: n((p) => p.mark?.status === 'present'),
    out: n((p) => p.mark?.status === 'out'),
    unconfirmed: n((p) => !p.mark),
    notConfirmedOut: n((p) => p.notConfirmedOut),
  };
}

export type RollFilter = 'all' | 'open' | 'done' | 'lapsed';

/** Not confirmed first (those the clock closed on top), then longest inside: the server's order, kept after a tap. */
const byNeed = (a: RollCallPerson, b: RollCallPerson) =>
  Number(Boolean(a.mark)) - Number(Boolean(b.mark)) ||
  Number(b.notConfirmedOut) - Number(a.notConfirmedOut) ||
  a.since - b.since ||
  a.passId.localeCompare(b.passId);

export const filterPeople = (people: readonly RollCallPerson[], f: RollFilter) =>
  [...people]
    .sort(byNeed)
    .filter((p) =>
      f === 'all'
        ? true
        : f === 'open'
          ? !p.mark
          : f === 'done'
            ? Boolean(p.mark)
            : p.notConfirmedOut,
    );

/** Everyone is accounted for: present or confirmed out. */
export const allConfirmed = (call: RollCall) =>
  call.counts.total > 0 && call.counts.unconfirmed === 0;
