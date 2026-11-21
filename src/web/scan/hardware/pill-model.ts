/** The pill's icons and what changes in them are worth saying aloud. */
import { fill } from '../ui/copy.ts';
import { HARDWARE_COPY as C } from './copy.ts';
import type { HardwareItem, HardwareKind, HardwareState } from './types.ts';

/** Kinds that count as connected hardware, in pill order. Network, sound and the rest stay in the panel. */
export const PILL_KINDS: readonly HardwareKind[] = [
  'camera',
  'reader',
  'nfc',
  'wedge',
  'keyboard',
  'serial',
  'hid',
  'usb',
  'bluetooth',
  'display',
  'battery',
];

const RANK: Record<HardwareState, number> = {
  error: 5,
  attention: 4,
  active: 3,
  ready: 2,
  off: 1,
  missing: 0,
  unsupported: 0,
};

export interface PillIcon {
  kind: HardwareKind;
  state: HardwareState;
}

/** One icon per detected kind, in its most urgent state. A battery shows only when low. */
export function pillIcons(items: readonly HardwareItem[]): PillIcon[] {
  const icons: PillIcon[] = [];
  for (const kind of PILL_KINDS) {
    const units = items.filter(
      (i) => i.kind === kind && RANK[i.state] >= 2 && !(kind === 'keyboard' && i.builtIn),
    );
    if (!units.length) continue;
    if (kind === 'battery' && !units.some((u) => u.state === 'attention')) continue;
    const top = units.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
    icons.push({ kind, state: top.state });
  }
  return icons;
}

/** The pill's accessible name: each icon and its state. */
export function pillLabel(icons: readonly PillIcon[]): string {
  if (!icons.length) return fill(C.pill, { list: C.none });
  const list = icons.map((i) => `${C.names[i.kind]} ${C.states[i.state].toLowerCase()}`).join(', ');
  return fill(C.pill, { list });
}

/** What to announce between two enumerations: connects, losses and recoveries. Null for none. */
export function changeOf(before: readonly PillIcon[], after: readonly PillIcon[]): string | null {
  const lines: string[] = [];
  const was = new Map(before.map((i) => [i.kind, i.state]));
  const now = new Map(after.map((i) => [i.kind, i.state]));
  for (const { kind, state } of after) {
    const name = C.names[kind];
    const prev = was.get(kind);
    if (prev === undefined) lines.push(fill(C.announce.connected, { name }));
    else if (state === 'error' && prev !== 'error') lines.push(fill(C.announce.lost, { name }));
    else if (state === 'active' && prev === 'error') lines.push(fill(C.announce.back, { name }));
    else if (state === 'active' && (prev === 'attention' || (kind === 'nfc' && prev !== 'active')))
      lines.push(fill(C.announce.on, { name }));
  }
  for (const { kind } of before)
    if (!now.has(kind)) lines.push(fill(C.announce.lost, { name: C.names[kind] }));
  return lines.length ? lines.join('. ') : null;
}
