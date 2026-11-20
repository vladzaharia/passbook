import type { RollCall, RollCallPerson } from '../../../shared/contracts/scan-roll-call.ts';
import { recount } from './roll-call-model.ts';
import type { RollCallPort } from './use-roll-call.ts';

export const T0 = Date.UTC(2026, 10, 18, 9, 41);
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const NAMES = ['Maya Okafor', 'Leo Park', 'Ana Ruiz', 'Sam Kim', 'Ira Novak', 'Tess Lund'];

export const person = (n: number, over: Partial<RollCallPerson> = {}): RollCallPerson => ({
  passId: id(n),
  holder: NAMES[n % NAMES.length] ?? `Person ${n}`,
  plan: n % 3 === 0 ? 'Visitor' : 'Staff',
  host: null,
  place: 'zone:hq',
  placeName: 'HQ',
  since: T0 - (n + 1) * 20 * 60_000,
  basis: 'in_now',
  presence: 'in',
  late: false,
  mark: null,
  notConfirmedOut: false,
  ...over,
});

export function call(people: RollCallPerson[], over: Partial<RollCall> = {}): RollCall {
  const base: RollCall = {
    id: id(900),
    placeNames: ['HQ'],
    startedAt: T0,
    startedBy: 'Front desk',
    endedAt: null,
    endedBy: null,
    rev: 1,
    serverNow: T0,
    counts: {
      total: people.length,
      present: 0,
      out: 0,
      unconfirmed: 0,
      notConfirmedOut: 0,
      late: people.filter((p) => p.late).length,
      inNow: people.filter((p) => p.basis === 'in_now').length,
      tappedIn: people.filter((p) => p.basis === 'tapped_in').length,
    },
    people,
    ...over,
  };
  return { ...base, counts: { ...base.counts, ...recount(base, people) } };
}

export interface FakeRoll extends RollCallPort {
  calls: { marks: { id: string; marks: unknown[] }[]; end: string[]; start: number };
  server: RollCall | null;
  fail: Error | null;
  /** Marks for these people are refused with the code. */
  refuse: Map<string, string>;
}

/** A server that applies marks by the later `at`, as the real one does. */
export function fakeRollCall(start: RollCall | null): FakeRoll {
  const f: FakeRoll = {
    calls: { marks: [], end: [], start: 0 },
    server: start,
    fail: null,
    refuse: new Map(),
    current: async () => ({ rollCall: f.server }),
    start: async () => {
      f.calls.start++;
      f.server ??= call([person(0), person(1), person(2)]);
      return f.server;
    },
    marks: async (cid, marks) => {
      f.calls.marks.push({ id: cid, marks });
      if (f.fail) throw f.fail;
      const cur = f.server;
      if (!cur) throw new Error('no call');
      const people = cur.people.map((p) => {
        if (f.refuse.has(p.passId)) return p;
        const m = marks.filter((x) => x.passId === p.passId).sort((a, b) => b.at - a.at)[0];
        if (!m || (p.mark && p.mark.at >= m.at)) return p;
        return {
          ...p,
          mark: m.status === 'none' ? null : { status: m.status, by: 'Other desk', at: m.at },
        };
      });
      f.server = call(people, { id: cur.id, rev: cur.rev + 1 });
      const results = marks.map((m) => {
        const code = f.refuse.get(m.passId);
        return {
          rollCallId: cur.id,
          passId: m.passId,
          ...(code ? { status: 'refused' as const, code } : { status: 'applied' as const }),
        };
      });
      return { ...f.server, results };
    },
    end: async (cid) => {
      f.calls.end.push(cid);
      const done = { ...(f.server as RollCall), endedAt: T0 + 1 };
      f.server = null;
      return done;
    },
  };
  return f;
}
