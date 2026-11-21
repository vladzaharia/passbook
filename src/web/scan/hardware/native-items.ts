/** The native shell's hardware list (bridge v1) as rows and camera units. */
import type { NativeHardwareEntry } from '../../../shared/contracts/scan-hardware.ts';
import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { fill } from '../ui/copy.ts';
import { HARDWARE_COPY as C } from './copy.ts';
import type { CameraUnit, HardwareItem, HardwareKind, HardwareState, Probe } from './types.ts';

const KIND: Record<NativeHardwareEntry['kind'], HardwareKind | null> = {
  camera: 'camera',
  barcode: 'reader',
  nfc: 'nfc',
  keyboard: 'keyboard',
  usb: 'usb',
  bluetooth: 'bluetooth',
  display: 'display',
  haptics: 'haptics',
  // The sound row is the app's own setting; a speaker adds nothing to it.
  speaker: null,
};

export function stateOf(entry: Pick<NativeHardwareEntry, 'state' | 'connected'>): HardwareState {
  switch (entry.state) {
    case 'needs-permission':
      return 'attention';
    case 'unavailable':
      return entry.connected === false ? 'missing' : 'off';
    default:
      return entry.state;
  }
}

export const nativeEntries = (
  native: NativeScannerCapabilities | undefined,
  kind: HardwareKind,
): NativeHardwareEntry[] => (native?.hardware ?? []).filter((e) => KIND[e.kind] === kind);

/** Rows for one kind from the shell, or null when it listed none (the browser's then stand). */
export function nativeRows(
  native: NativeScannerCapabilities | undefined,
  kind: HardwareKind,
): HardwareItem[] | null {
  const entries = nativeEntries(native, kind);
  if (!entries.length) return null;
  return entries.map((e, i) => {
    const detail =
      e.reason ??
      (kind === 'reader' && e.trigger ? C.trigger[e.trigger] : undefined) ??
      (e.facing ? C.facing[e.facing] : undefined);
    return {
      id: `${kind}:n${i}`,
      kind,
      name:
        e.name ||
        (entries.length > 1 ? fill(C.device, { kind: C.names[kind], n: i + 1 }) : C.names[kind]),
      state: stateOf(e),
      ...(detail ? { detail } : {}),
      builtIn: e.builtIn,
      connected: e.connected,
      ...(e.facing ? { facing: e.facing } : {}),
    };
  });
}

/** The shell's cameras replace the browser's list: they carry facing and the OS's names. */
export function withNativeCameras(
  probe: Probe,
  native: NativeScannerCapabilities | undefined,
): Probe {
  const cams = nativeEntries(native, 'camera');
  if (!cams.length) return probe;
  const units: CameraUnit[] = cams.map((e) => ({
    deviceId: e.id,
    label: e.name ?? '',
    facing: e.facing ?? null,
    builtIn: e.builtIn,
    connected: e.connected,
  }));
  const p = native?.camera.permission;
  return {
    ...probe,
    cameras: { ok: true, units },
    cameraPermission:
      p === 'granted' || p === 'denied' || p === 'prompt'
        ? p
        : p === 'restricted'
          ? 'denied'
          : probe.cameraPermission,
  };
}
