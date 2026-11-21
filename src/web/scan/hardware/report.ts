/**
 * The hardware summary the device report carries: kinds, counts, builtIn, connected and state.
 * Names, labels, ids and reasons never leave the device.
 */
import type { ReportedHardware } from '../../../shared/contracts/scan-hardware.ts';
import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { isFound } from './items.ts';
import type { HardwareItem, HardwareKind, HardwareState } from './types.ts';

export const HARDWARE_EVENT = 'passbook:hardware';

const KIND: Partial<Record<HardwareKind, ReportedHardware['kind']>> = {
  camera: 'camera',
  reader: 'barcode',
  nfc: 'nfc',
  wedge: 'keyboard',
  keyboard: 'keyboard',
  usb: 'usb',
  hid: 'hid',
  serial: 'serial',
  bluetooth: 'bluetooth',
  display: 'display',
};
const STATE: Record<HardwareState, ReportedHardware['state'] | null> = {
  active: 'active',
  ready: 'ready',
  attention: 'needs-permission',
  error: 'error',
  off: 'off',
  missing: null,
  unsupported: null,
};

export function summarize(items: readonly HardwareItem[]): ReportedHardware[] {
  const out: ReportedHardware[] = [];
  for (const i of items) {
    const kind = KIND[i.kind];
    const state = STATE[i.state];
    // The wedge row off means the view reads nothing; it is not a device.
    if (!kind || !state || !isFound(i) || (i.kind === 'wedge' && i.state === 'off')) continue;
    const builtIn = i.builtIn ?? (i.kind === 'camera' && i.facing !== 'external');
    const connected = i.connected ?? null;
    const same = out.find(
      (o) =>
        o.kind === kind && o.state === state && o.builtIn === builtIn && o.connected === connected,
    );
    if (same) same.count = Math.min(16, same.count + 1);
    else if (out.length < 16) out.push({ kind, count: 1, builtIn, connected, state });
  }
  return out;
}

let published: ReportedHardware[] | null = null;

/** The device report reads this; a change asks it to report again. */
export function publishHardware(items: readonly HardwareItem[]): void {
  const next = summarize(items);
  if (JSON.stringify(next) === JSON.stringify(published)) return;
  published = next;
  window.dispatchEvent(new Event(HARDWARE_EVENT));
}

export const reportedHardware = (): ReportedHardware[] | null => published;

/** The shell's own list stays on the device: the summary stands for it. */
export function withoutNativeHardware(
  native: NativeScannerCapabilities,
): Omit<NativeScannerCapabilities, 'hardware'> {
  const { hardware: _hardware, ...rest } = native;
  return rest;
}
