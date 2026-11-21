/**
 * Each scanning row's own instruction, and the panel's order: ways to scan first (best first),
 * then the rest of the hardware, then what is not there.
 */
import { HARDWARE_COPY as C } from './copy.ts';
import { isFound } from './items.ts';
import type { HardwareItem, HardwareKind } from './types.ts';

/** Ways to scan, in the order a person should reach for them. */
const RANK: Partial<Record<HardwareKind, number>> = {
  reader: 0,
  nfc: 1,
  camera: 2,
  wedge: 3,
  keyboard: 4,
  serial: 5,
  hid: 6,
  bluetooth: 7,
};

export const scans = (i: HardwareItem) => RANK[i.kind] !== undefined;

/** It can read now: found, not off or failed, and not waiting on a person. */
export const usable = (i: HardwareItem) =>
  isFound(i) && i.state !== 'off' && i.state !== 'error' && i.status === undefined;

const G = C.how;

/** The row's instruction, or none. What to do instead when it cannot read now. */
export function howOf(i: HardwareItem, camera: boolean): string | undefined {
  if (!scans(i)) return undefined;
  if (i.status === C.paused) return G.paused;
  switch (i.kind) {
    case 'camera':
      if (!camera) return undefined;
      if (i.state === 'attention') return G.allowCamera;
      if (i.state === 'error') return G.retry;
      if (i.state === 'off') return G.cameraOn;
      if (!isFound(i)) return undefined;
      return i.facing === 'front' ? G.front : i.facing === 'back' ? G.back : G.camera;
    case 'reader':
      if (!usable(i)) return undefined;
      return i.trigger === 'pistol' ? G.trigger : G.reader;
    case 'nfc':
      if (i.state === 'off' || i.state === 'missing')
        return i.builtIn === false ? undefined : G.nfcOn;
      if (i.state === 'attention') return G.allowNfc;
      if (!usable(i)) return undefined;
      if (i.action?.kind === 'nfc') return G.startNfc;
      return i.wallet ? G.wallet : G.tag;
    case 'wedge':
      if (i.state === 'missing') return G.detect;
      return usable(i) ? G.handheld : undefined;
    case 'keyboard':
      return usable(i) && i.builtIn === false && i.connected === true ? G.handheld : undefined;
    default:
      return usable(i) && i.connected !== false ? G.handheld : undefined;
  }
}

/**
 * Rows with instructions, in panel order. `camera` is false where the view runs no camera; a
 * monitor (`reads` false) gets no instructions. The best usable way is marked.
 */
export function panelRows(
  items: readonly HardwareItem[],
  { reads, camera }: { reads: boolean; camera: boolean },
): HardwareItem[] {
  const rows = items.map((i) => {
    const how = reads ? howOf(i, camera) : undefined;
    return how ? { ...i, how } : i;
  });
  const rank = (i: HardwareItem) => RANK[i.kind] ?? 99;
  const ways = rows
    .filter((i) => reads && scans(i) && (i.kind !== 'camera' || camera) && isFound(i))
    .sort((a, b) => Number(usable(b)) - Number(usable(a)) || rank(a) - rank(b));
  const rest = rows.filter((i) => !ways.includes(i));
  const best = ways.find(usable);
  return [
    ...ways.map((i) => (i === best ? { ...i, best: true } : i)),
    ...rest.filter(isFound),
    ...rest.filter((i) => !isFound(i)),
  ];
}
