/** How to scan here: the ways this device can read, best first. */
import { isFound } from './items.ts';
import type { HardwareItem, HardwareKind } from './types.ts';

export type GuideStep = 'reader' | 'wallet' | 'nfc' | 'camera' | 'front' | 'handheld' | 'none';

const usable = (i: HardwareItem) =>
  isFound(i) && i.state !== 'off' && i.state !== 'error' && i.status === undefined;

/** Ways a handheld scanner shows up: the wedge, an attached keyboard, a serial or HID scanner. */
const HANDHELD: readonly HardwareKind[] = ['wedge', 'keyboard', 'serial', 'hid'];

/**
 * One step per way, in the order a person should reach for it. `camera` is false where the view
 * runs no camera (the operator desk); a monitor reads nothing and gets no steps.
 */
export function guideOf(
  items: readonly HardwareItem[],
  { reads, camera }: { reads: boolean; camera: boolean },
): GuideStep[] {
  if (!reads) return [];
  const steps: GuideStep[] = [];
  const of = (kind: HardwareKind) => items.filter((i) => i.kind === kind && usable(i));
  if (of('reader').length) steps.push('reader');
  const nfc = of('nfc')[0];
  if (nfc) steps.push(nfc.wallet ? 'wallet' : 'nfc');
  const cams = camera
    ? items.filter(
        (i) => i.kind === 'camera' && isFound(i) && i.state !== 'off' && i.status === undefined,
      )
    : [];
  if (cams.length) steps.push(cams.every((c) => c.facing === 'front') ? 'front' : 'camera');
  const handheld = HANDHELD.some((k) =>
    of(k).some((i) => k !== 'keyboard' || (i.connected === true && i.builtIn === false)),
  );
  if (handheld) steps.push('handheld');
  return steps.length ? steps : ['none'];
}
