/**
 * Hardware enumeration through APIs that never prompt: granted devices only, permission queries,
 * and feature checks. Labels and names stay in this tab; nothing here reaches the server.
 */
import type { CameraUnit, Facing, Listed, PeripheralUnit, Probe } from './types.ts';

type Lister = { getDevices?: () => Promise<unknown[]> };
type Named = {
  productName?: string;
  name?: string;
  opened?: boolean;
  /** A serial port that is open. */
  readable?: unknown;
};
type InputInfo = MediaDeviceInfo & {
  getCapabilities?: () => { facingMode?: string[] };
};

/** The parts of `navigator`, `screen` and `permissions` enumeration reads. Tests pass stubs. */
export interface ProbeEnv {
  mediaDevices?: { enumerateDevices?: () => Promise<MediaDeviceInfo[]> };
  permissions?: { query(d: { name: string }): Promise<{ state: string }> };
  usb?: Lister;
  hid?: Lister;
  serial?: { getPorts?: () => Promise<unknown[]> };
  bluetooth?: Lister;
  getBattery?: () => Promise<{ level: number; charging: boolean }>;
  screen?: { isExtended?: boolean };
  getScreenDetails?: () => Promise<{ screens: readonly unknown[] }>;
  ndefReader?: unknown;
  wakeLock?: unknown;
  canBuzz: boolean;
}

const FRONT = /front|user|face/i;
const BACK = /back|rear|environment|world/i;

export function facingOf(device: MediaDeviceInfo): Facing {
  let modes: string[] = [];
  try {
    modes = (device as InputInfo).getCapabilities?.().facingMode ?? [];
  } catch {
    // Older engines throw for a device without access: the label decides.
    modes = [];
  }
  if (modes.includes('user')) return 'front';
  if (modes.includes('environment')) return 'back';
  if (FRONT.test(device.label)) return 'front';
  if (BACK.test(device.label)) return 'back';
  return device.label ? 'external' : null;
}

async function cameras(env: ProbeEnv): Promise<Listed<CameraUnit>> {
  const list = env.mediaDevices?.enumerateDevices;
  if (typeof list !== 'function') return { ok: false };
  try {
    const all = await list.call(env.mediaDevices);
    const units = all
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label, facing: facingOf(d) }));
    return { ok: true, units };
  } catch {
    return { ok: true, units: [] };
  }
}

async function granted(api: Lister | undefined): Promise<Listed<PeripheralUnit>> {
  if (typeof api?.getDevices !== 'function') return { ok: false };
  try {
    const devices = (await api.getDevices.call(api)) as Named[];
    return {
      ok: true,
      units: devices.map((d) => ({
        name: d.productName || d.name || '',
        ...(d.opened || d.readable ? { open: true } : {}),
      })),
    };
  } catch {
    // A permissions policy can forbid the API in this frame: treat it as absent.
    return { ok: false };
  }
}

async function permission(env: ProbeEnv, name: string): Promise<string> {
  try {
    return (await env.permissions?.query({ name }))?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function screens(env: ProbeEnv): Promise<Probe['screens']> {
  const extended = env.screen?.isExtended;
  if (extended === undefined) return null;
  if (
    typeof env.getScreenDetails === 'function' &&
    (await permission(env, 'window-management')) === 'granted'
  ) {
    try {
      return { count: (await env.getScreenDetails()).screens.length, extended };
    } catch {
      return { count: null, extended };
    }
  }
  return { count: extended ? null : 1, extended };
}

async function battery(env: ProbeEnv): Promise<Probe['battery']> {
  if (typeof env.getBattery !== 'function') return null;
  try {
    const b = await env.getBattery();
    return { level: b.level, charging: b.charging };
  } catch {
    return null;
  }
}

export async function probeHardware(env: ProbeEnv): Promise<Probe> {
  const [cams, camPermission, usb, hid, serial, bluetooth, bat, scr] = await Promise.all([
    cameras(env),
    permission(env, 'camera'),
    granted(env.usb),
    granted(env.hid),
    granted(
      env.serial?.getPorts ? { getDevices: env.serial.getPorts.bind(env.serial) } : undefined,
    ),
    granted(env.bluetooth),
    battery(env),
    screens(env),
  ]);
  return {
    cameras: cams,
    cameraPermission:
      camPermission === 'granted' || camPermission === 'denied' || camPermission === 'prompt'
        ? camPermission
        : 'unknown',
    usb,
    hid,
    serial,
    bluetooth,
    battery: bat,
    screens: scr,
    webNfc: env.ndefReader !== undefined,
    wakeLock: env.wakeLock !== undefined,
    haptics: env.canBuzz,
  };
}

/** The browser's own environment. */
export function browserProbeEnv(canBuzz: boolean): ProbeEnv {
  const nav = navigator as Navigator & Partial<Omit<ProbeEnv, 'canBuzz' | 'screen'>>;
  const win = window as Window & { getScreenDetails?: ProbeEnv['getScreenDetails'] };
  return {
    mediaDevices: nav.mediaDevices,
    permissions: nav.permissions,
    usb: nav.usb,
    hid: nav.hid,
    serial: nav.serial,
    bluetooth: nav.bluetooth,
    getBattery: nav.getBattery?.bind(nav),
    screen: window.screen as Screen & { isExtended?: boolean },
    getScreenDetails: win.getScreenDetails?.bind(win),
    ndefReader: (globalThis as { NDEFReader?: unknown }).NDEFReader,
    wakeLock: nav.wakeLock,
    canBuzz,
  };
}

export const WATCH_DEBOUNCE_MS = 250;

/** Events that mean the list may have changed, debounced. Returns stop. */
export function watchHardware(env: ProbeEnv, changed: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(changed, WATCH_DEBOUNCE_MS);
  };
  const targets: [EventTarget | undefined, string[]][] = [
    [env.mediaDevices as EventTarget | undefined, ['devicechange']],
    [env.usb as EventTarget | undefined, ['connect', 'disconnect']],
    [env.hid as EventTarget | undefined, ['connect', 'disconnect']],
    [env.serial as EventTarget | undefined, ['connect', 'disconnect']],
  ];
  const stops: (() => void)[] = [];
  let stopped = false;
  const later = (target: unknown, names: string[]) => {
    const t = target as EventTarget;
    if (stopped || typeof t?.addEventListener !== 'function') return;
    for (const name of names) {
      t.addEventListener(name, onChange);
      stops.push(() => t.removeEventListener(name, onChange));
    }
  };
  for (const [target, names] of targets) {
    if (typeof target?.addEventListener !== 'function') continue;
    for (const name of names) {
      target.addEventListener(name, onChange);
      stops.push(() => target.removeEventListener(name, onChange));
    }
  }
  // Either can be missing or refused; enumeration then just runs on the other events.
  void env.getBattery?.().then(
    (b) => later(b, ['levelchange', 'chargingchange']),
    () => undefined,
  );
  void env.permissions?.query({ name: 'camera' }).then(
    (status) => later(status, ['change']),
    () => undefined,
  );
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const stop of stops.splice(0)) stop();
  };
}
