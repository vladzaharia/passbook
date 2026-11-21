/** Probes and scanner states for tests and the visual gallery (`?visual=1&surface=hardware`). */
import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import type { LiveHardware, Probe } from './types.ts';

export const HW_NOW = Date.UTC(2026, 10, 20, 18, 30);

export function probeFixture(over: Partial<Probe> = {}): Probe {
  return {
    cameras: {
      ok: true,
      units: [
        { deviceId: 'cam-back', label: 'Back Camera', facing: 'back' },
        { deviceId: 'cam-front', label: 'Front Camera', facing: 'front' },
      ],
    },
    cameraPermission: 'granted',
    usb: { ok: true, units: [] },
    hid: { ok: true, units: [] },
    serial: { ok: true, units: [] },
    bluetooth: { ok: false },
    battery: { level: 0.76, charging: false },
    screens: { count: 1, extended: false },
    webNfc: false,
    wakeLock: true,
    haptics: false,
    ...over,
  };
}

export function liveFixture(over: Partial<LiveHardware> = {}): LiveHardware {
  return {
    reads: true,
    focused: true,
    readerUsable: false,
    camera: 'live',
    cameraChoice: 'back',
    activeCameraId: 'cam-back',
    hasWide: false,
    started: true,
    online: true,
    queued: 0,
    native: undefined,
    readerKind: 'none',
    wedge: { seenAt: null, badLayout: false, tracked: true },
    webNfc: 'idle',
    sound: true,
    now: HW_NOW,
    ...over,
  };
}

/** An Android handheld with a built-in barcode reader, NFC and two cameras (bridge v1). */
export function androidFixture(
  over: Partial<NativeScannerCapabilities> = {},
): NativeScannerCapabilities {
  return {
    platform: 'android',
    appVersion: '2.1',
    camera: { available: true, permission: 'granted' },
    keyboard: { supported: true, connected: false, connectionObservable: true },
    nfc: { available: true, reading: true, continuous: true, formats: ['ndef', 'tag-uid'] },
    haptics: true,
    vas: { deviceSupported: false, available: false, reader: 'none', reason: '' },
    externalReader: { mode: 'keyboard', connected: false },
    customerDisplay: { supported: false, available: false, active: false },
    hardware: [
      {
        kind: 'camera',
        id: 'c0',
        name: 'Rear camera',
        builtIn: true,
        connected: true,
        state: 'ready',
        facing: 'back',
      },
      {
        kind: 'camera',
        id: 'c1',
        name: 'Front camera',
        builtIn: true,
        connected: true,
        state: 'ready',
        facing: 'front',
      },
      {
        kind: 'barcode',
        id: 'b0',
        name: 'Scan engine',
        builtIn: true,
        connected: true,
        state: 'ready',
        trigger: 'side',
      },
      { kind: 'nfc', id: 'n0', builtIn: true, connected: true, state: 'ready' },
      { kind: 'haptics', id: 'h0', builtIn: true, connected: true, state: 'ready' },
    ],
    ...over,
  };
}

export const HARDWARE_CASES = [
  'allowed',
  'prompt',
  'denied',
  'wedge',
  'nfc-off',
  'offline',
  'android',
  'reader',
  'paused',
] as const;
export type HardwareCase = (typeof HARDWARE_CASES)[number];

/** Each case as enumeration plus the scanner's state. */
export function hardwareCase(c: HardwareCase): { probe: Probe; live: LiveHardware } {
  switch (c) {
    case 'prompt':
      return {
        probe: probeFixture({
          cameraPermission: 'prompt',
          cameras: { ok: true, units: [{ deviceId: '', label: '', facing: null }] },
        }),
        live: liveFixture({ camera: 'off', started: false, activeCameraId: null }),
      };
    case 'denied':
      return {
        probe: probeFixture({
          cameraPermission: 'denied',
          cameras: { ok: true, units: [{ deviceId: '', label: '', facing: null }] },
        }),
        live: liveFixture({ camera: 'blocked', activeCameraId: null }),
      };
    case 'wedge':
      return {
        probe: probeFixture({ serial: { ok: true, units: [{ name: '', open: true }] } }),
        live: liveFixture({ wedge: { seenAt: HW_NOW - 20_000, badLayout: false, tracked: true } }),
      };
    case 'nfc-off':
      return {
        probe: probeFixture({
          webNfc: true,
          haptics: true,
          battery: { level: 0.14, charging: false },
        }),
        live: liveFixture({
          native: androidFixture({
            nfc: { available: false, reading: false, formats: [] },
            hardware: androidFixture().hardware?.map((h) =>
              h.kind === 'nfc'
                ? { ...h, state: 'off' as const, reason: 'NFC is off in Settings' }
                : h,
            ),
          }),
          readerKind: 'barcode',
        }),
      };
    case 'offline':
      return { probe: probeFixture(), live: liveFixture({ online: false, queued: 3 }) };
    case 'android':
      return {
        probe: probeFixture({ webNfc: true, haptics: true }),
        live: liveFixture({
          native: androidFixture(),
          readerKind: 'barcode',
          activeCameraId: null,
        }),
      };
    case 'reader':
      return {
        probe: probeFixture(),
        live: liveFixture({ readerUsable: true, readerKind: 'barcode' }),
      };
    case 'paused':
      return {
        probe: probeFixture(),
        live: liveFixture({ readerUsable: true, readerKind: 'barcode', focused: false }),
      };
    default:
      return { probe: probeFixture(), live: liveFixture() };
  }
}
