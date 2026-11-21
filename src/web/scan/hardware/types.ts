import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import type { WebNfcStatus } from '../input/web-nfc-source.ts';
import type { CameraStatus } from '../machine/types.ts';
import type { CameraChoice } from '../ui/scan-menu.tsx';

export type HardwareKind =
  | 'camera'
  | 'wedge'
  | 'reader'
  | 'nfc'
  | 'keyboard'
  | 'usb'
  | 'hid'
  | 'serial'
  | 'bluetooth'
  | 'battery'
  | 'screens'
  | 'display'
  | 'network'
  | 'sound'
  | 'haptics'
  | 'awake';

/**
 * `attention` needs a person: camera access, a low battery, a keyboard layout. `missing` is an API
 * with nothing behind it; `unsupported` is no API at all.
 */
export type HardwareState =
  | 'active'
  | 'ready'
  | 'attention'
  | 'error'
  | 'off'
  | 'missing'
  | 'unsupported';

export type HardwareAction =
  | { kind: 'allow' }
  | { kind: 'retry' }
  | { kind: 'use'; choice: CameraChoice }
  | { kind: 'nfc' }
  | { kind: 'test' }
  /** Web Serial: pick a serial scanner. Shown only where the API exists. */
  | { kind: 'connect' };

export interface HardwareItem {
  /** Stable per unit: `camera:<n>`, `usb:<n>`, or the kind. */
  id: string;
  kind: HardwareKind;
  name: string;
  state: HardwareState;
  /** The state's word; the default for the state when absent. */
  status?: string;
  /** One fact: facing or label, last read, percent, or why it is off. */
  detail?: string;
  action?: HardwareAction;
  /** Part of the device, not attached. Reported. */
  builtIn?: boolean;
  /** Null when the OS cannot tell. Reported. */
  connected?: boolean | null;
  /** Cameras. */
  facing?: Facing;
  /** NFC that reads Wallet passes, not only tags. */
  wallet?: boolean;
}

export type Facing = 'front' | 'back' | 'external' | null;

export interface CameraUnit {
  deviceId: string;
  /** Empty until camera access is granted. */
  label: string;
  facing: Facing;
  /** From the shell's list. */
  builtIn?: boolean;
  connected?: boolean | null;
}

export interface PeripheralUnit {
  name: string;
  open?: boolean;
}

/** A list the browser gave, or why it could not. */
export type Listed<T> = { ok: true; units: T[] } | { ok: false };

/** What enumeration found. Every field comes from an API that never prompts. */
export interface Probe {
  cameras: Listed<CameraUnit>;
  cameraPermission: 'granted' | 'denied' | 'prompt' | 'unknown';
  usb: Listed<PeripheralUnit>;
  hid: Listed<PeripheralUnit>;
  serial: Listed<PeripheralUnit>;
  bluetooth: Listed<PeripheralUnit>;
  battery: { level: number; charging: boolean } | null;
  /** Null: the browser cannot tell. */
  screens: { count: number | null; extended: boolean } | null;
  webNfc: boolean;
  wakeLock: boolean;
  haptics: boolean;
}

/** What the running scanner knows: the store, the native shell and the wedge. */
export interface LiveHardware {
  /** The device reads codes (a scanner); a monitor only shows them. */
  reads: boolean;
  /** Null where the view runs no camera: a monitor, the operator desk. */
  camera: CameraStatus | null;
  cameraChoice: CameraChoice;
  /** The camera the stream runs on, when one does. */
  activeCameraId: string | null;
  hasWide: boolean;
  started: boolean;
  online: boolean;
  queued: number;
  native: NativeScannerCapabilities | undefined;
  /** The scanner reads with the built-in barcode or Wallet reader. */
  readerKind: 'none' | 'barcode' | 'nfc';
  wedge: { seenAt: number | null; badLayout: boolean; tracked: boolean };
  webNfc: WebNfcStatus;
  sound: boolean | null;
  now: number;
}
