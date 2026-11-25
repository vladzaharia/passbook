/** The floor's facts as pure functions: who is where on a roll call, what a device line says. */
import type { RollCall, RollCallPerson } from '../../../../shared/contracts/scan-roll-call.ts';
import type { SessionDevices } from '../../../../shared/contracts/scanning-session-devices.ts';
import type { OperatorView } from '../keys.ts';

export interface ZoneProgress {
  name: string;
  marked: number;
  total: number;
}

const marked = (p: RollCallPerson) => p.mark !== null && p.mark.status !== 'none';

/** Confirmed against listed, by zone, in the order the zones first appear. */
export function byZone(call: RollCall): ZoneProgress[] {
  const zones = new Map<string, ZoneProgress>();
  for (const p of call.people) {
    const z = zones.get(p.placeName) ?? { name: p.placeName, marked: 0, total: 0 };
    z.total += 1;
    if (marked(p)) z.marked += 1;
    zones.set(p.placeName, z);
  }
  return [...zones.values()];
}

/** Marks by the device and person that made them, most first. */
export function byDevice(call: RollCall): { by: string; count: number }[] {
  const tally = new Map<string, number>();
  for (const p of call.people)
    if (p.mark && marked(p)) tally.set(p.mark.by, (tally.get(p.mark.by) ?? 0) + 1);
  return [...tally]
    .map(([by, count]) => ({ by, count }))
    .sort((a, b) => b.count - a.count || a.by.localeCompare(b.by));
}

/** The next person still to confirm after `passId`, in the order the list shows; the first when none is named. */
export function nextToConfirm(
  ordered: readonly RollCallPerson[],
  passId: string | null,
): string | null {
  const open = ordered.filter((p) => !p.mark);
  if (!open.length) return null;
  const at = passId ? ordered.findIndex((p) => p.passId === passId) : -1;
  return (ordered.slice(at + 1).find((p) => !p.mark) ?? open[0])?.passId ?? null;
}

/** `Offline · 4 min`, or `Online`. */
export function deviceState(
  d: SessionDevices['items'][number],
  now: number,
): { online: boolean; text: string } {
  if (d.online) return { online: true, text: 'Online' };
  if (d.lastSeenAt === null) return { online: false, text: 'Offline' };
  const min = Math.max(1, Math.round((now - d.lastSeenAt) / 60_000));
  return { online: false, text: min >= 60 ? 'Offline' : `Offline · ${min} min` };
}

export type RollFilter = 'open' | 'lapsed' | 'present' | 'out';

const MARKED: Record<'present' | 'out', (p: RollCallPerson) => boolean> = {
  present: (p) => p.mark?.status === 'present',
  out: (p) => p.mark?.status === 'out',
};

/** Not confirmed first, those the clock closed on top, then longest inside: the order a desk works the list. */
const byNeed = (a: RollCallPerson, b: RollCallPerson) =>
  Number(Boolean(a.mark)) - Number(Boolean(b.mark)) ||
  Number(b.notConfirmedOut) - Number(a.notConfirmedOut) ||
  a.since - b.since ||
  a.passId.localeCompare(b.passId);

export const rollOrder = (call: RollCall): RollCallPerson[] => [...call.people].sort(byNeed);

export function rollRows(call: RollCall, filter: RollFilter): RollCallPerson[] {
  const rows = rollOrder(call);
  return filter === 'open'
    ? rows.filter((p) => !p.mark)
    : filter === 'lapsed'
      ? rows.filter((p) => p.notConfirmedOut)
      : rows.filter(MARKED[filter]);
}

export const rollCount = (call: RollCall, filter: RollFilter): number =>
  rollRows(call, filter).length;

/** The list views a session has, in tab order: Who's in needs a counted place. */
export const viewsFor = (f: { tracks: boolean }): OperatorView[] => [
  'activity',
  'problems',
  ...(f.tracks ? (['inside'] as const) : []),
];
