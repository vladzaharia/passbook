/** Enumeration and the running scanner, as rows: every kind the app can use, found or not. */
import { formatTime } from '../../lib/format.ts';
import { fill } from '../ui/copy.ts';
import type { CameraChoice } from '../ui/scan-menu.tsx';
import { HARDWARE_COPY as C } from './copy.ts';
import { nativeEntries, nativeRows, withNativeCameras } from './native-items.ts';
import type {
  CameraUnit,
  HardwareItem,
  HardwareKind,
  HardwareState,
  Listed,
  LiveHardware,
  PeripheralUnit,
  Probe,
} from './types.ts';

/** A wedge read this recent shows the scanner as on. */
export const WEDGE_ACTIVE_MS = 60_000;
const WIDE = /ultra.?wide|back.?wide|0[.,]5/i;

const item = (
  kind: HardwareKind,
  state: HardwareState,
  extra: Partial<HardwareItem> = {},
): HardwareItem => ({ id: kind, kind, name: C.names[kind], state, ...extra });

const choiceOf = (unit: CameraUnit): CameraChoice | null =>
  unit.facing === 'front'
    ? 'front'
    : unit.facing === 'back'
      ? WIDE.test(unit.label)
        ? 'back-wide'
        : 'back'
      : null;

const facingWord = (unit: CameraUnit) =>
  unit.facing
    ? [C.facing[unit.facing], WIDE.test(unit.label) ? C.wide : null].filter(Boolean).join(' · ')
    : undefined;

function activeIndex(units: CameraUnit[], live: LiveHardware): number {
  const byId = units.findIndex((u) => u.deviceId && u.deviceId === live.activeCameraId);
  if (byId >= 0) return byId;
  const byChoice = units.findIndex((u) => choiceOf(u) === live.cameraChoice);
  return Math.max(byChoice, 0);
}

export function cameraItems(probe: Probe, live: LiveHardware): HardwareItem[] {
  if (!probe.cameras.ok) return [item('camera', 'unsupported', { detail: C.noCameraApi })];
  const units = probe.cameras.units;
  if (!units.length) return [item('camera', 'missing')];
  const status = live.camera;
  const denied = status === 'blocked' || probe.cameraPermission === 'denied';
  const asks =
    !denied &&
    probe.cameraPermission !== 'granted' &&
    status !== 'live' &&
    units.every((u) => !u.label);
  const current = activeIndex(units, live);
  return units.map((unit, i) => {
    const base: Partial<HardwareItem> = {
      id: `camera:${i}`,
      name: unit.label || fill(C.camera, { n: i + 1 }),
      facing: unit.facing,
      ...(unit.builtIn === undefined ? {} : { builtIn: unit.builtIn }),
      ...(unit.connected === undefined ? {} : { connected: unit.connected }),
      ...(facingWord(unit) ? { detail: facingWord(unit) } : {}),
    };
    const choice = choiceOf(unit);
    if (status === null) return item('camera', 'ready', base);
    if (denied)
      return item('camera', 'attention', {
        ...base,
        status: C.blocked,
        ...(i === 0 ? { action: { kind: 'allow' } } : {}),
      });
    if (status === 'disabled') return item('camera', 'off', { ...base, detail: C.cameraOff });
    if (status === 'live' && i === current) return item('camera', 'active', base);
    if ((status === 'unavailable' || status === 'decoder_failed') && i === current)
      return item('camera', 'error', { ...base, status: C.lost, action: { kind: 'retry' } });
    if (asks && i === 0) return item('camera', 'attention', { ...base, action: { kind: 'allow' } });
    return item('camera', 'ready', {
      ...base,
      ...(status === 'live' && choice && choice !== live.cameraChoice
        ? { action: { kind: 'use', choice } }
        : {}),
    });
  });
}

export function wedgeItem(live: LiveHardware): HardwareItem {
  if (!live.reads) return item('wedge', 'off', { detail: C.notUsed });
  const test = { action: { kind: 'test' } } as const;
  const seen = live.wedge.seenAt;
  const read = seen ? fill(C.lastRead, { time: formatTime(seen) }) : undefined;
  if (live.wedge.badLayout)
    return item('wedge', 'attention', { status: C.layoutWord, detail: C.layout, ...test });
  if (seen && live.now - seen < WEDGE_ACTIVE_MS)
    return item('wedge', 'active', { ...(read ? { detail: read } : {}), ...test });
  const attached =
    live.native?.externalReader.connected ||
    nativeEntries(live.native, 'keyboard').some((e) => !e.builtIn && e.connected);
  if (seen || attached) return item('wedge', 'ready', { detail: read ?? C.connected, ...test });
  return item('wedge', 'missing', test);
}

export function readerItems(live: LiveHardware): HardwareItem[] {
  const n = live.native;
  const using = live.started && live.readerKind === 'barcode';
  const rows = nativeRows(n, 'reader');
  if (rows) return rows.map((r) => (using && r.state === 'ready' ? { ...r, state: 'active' } : r));
  if (!n)
    return live.readerUsable
      ? [item('reader', using ? 'active' : 'ready', { detail: C.barcode, builtIn: true })]
      : [item('reader', 'unsupported', { detail: C.needsApp })];
  if (n.platform === 'android')
    return [item('reader', using ? 'active' : 'ready', { detail: C.barcode, builtIn: true })];
  return [item('reader', 'missing')];
}

export function nfcItem(live: LiveHardware, supported: boolean): HardwareItem {
  const n = live.native;
  if (n) {
    const vas = n.vas.available
      ? C.wallet
      : n.vas.deviceSupported
        ? n.vas.reason.slice(0, 80) || undefined
        : undefined;
    const using = live.started && live.readerKind === 'nfc';
    const row = nativeRows(n, 'nfc')?.[0];
    if (row)
      return {
        ...row,
        ...(row.detail || !vas ? {} : { detail: vas }),
        ...(n.vas.available ? { wallet: true } : {}),
        ...(using && row.state === 'ready' ? { state: 'active' } : {}),
      };
    if (!n.nfc.available) return item('nfc', 'missing');
    return item('nfc', n.nfc.reading || using ? 'active' : 'ready', {
      builtIn: true,
      ...(n.vas.available ? { wallet: true } : {}),
      ...(vas ? { detail: vas } : {}),
    });
  }
  if (!supported) return item('nfc', 'unsupported', { detail: C.notInBrowser });
  const arm = live.reads ? { action: { kind: 'nfc' } as const } : {};
  switch (live.webNfc) {
    case 'on':
      return item('nfc', 'active', { builtIn: true });
    case 'denied':
      return item('nfc', 'attention', { status: C.blocked, ...arm });
    case 'error':
      return item('nfc', 'error', arm.action ? { action: { kind: 'retry' } } : {});
    default:
      return item('nfc', 'ready', {
        builtIn: true,
        ...(live.reads ? { detail: C.tapToStart, ...arm } : {}),
      });
  }
}

/** Keyboards only the shell can list; the browser sees them as the wedge. */
export function keyboardItems(live: LiveHardware): HardwareItem[] {
  if (!live.native) return [];
  return nativeRows(live.native, 'keyboard') ?? [item('keyboard', 'missing')];
}

export function peripheralItems(
  kind: 'usb' | 'hid' | 'serial' | 'bluetooth',
  listed: Listed<PeripheralUnit>,
  connect = false,
): HardwareItem[] {
  if (!listed.ok) return [item(kind, 'unsupported', { detail: C.notInBrowser })];
  const add = connect ? { action: { kind: 'connect' } as const } : {};
  if (!listed.units.length) return [item(kind, 'missing', { detail: C.nonePaired, ...add })];
  return listed.units.map((unit, i) =>
    item(kind, unit.open ? 'active' : 'ready', {
      id: `${kind}:${i}`,
      // Another scanner can join from the last row.
      ...(i === listed.units.length - 1 ? add : {}),
      builtIn: false,
      connected: true,
      name: unit.name || fill(C.device, { kind: C.names[kind], n: i + 1 }),
      ...(unit.name ? { detail: C.names[kind] } : {}),
    }),
  );
}

export function batteryItem(probe: Probe): HardwareItem {
  const b = probe.battery;
  if (!b) return item('battery', 'unsupported', { detail: C.notInBrowser });
  const level = Math.round(b.level * 100);
  if (b.charging) return item('battery', 'ready', { detail: fill(C.charging, { level }) });
  return level <= 20
    ? item('battery', 'attention', { status: C.low, detail: fill(C.level, { level }) })
    : item('battery', 'ready', { detail: fill(C.level, { level }) });
}

export function screensItem(probe: Probe): HardwareItem {
  const s = probe.screens;
  if (!s) return item('screens', 'unsupported', { detail: C.notInBrowser });
  const detail =
    s.count === 1 ? C.oneScreen : s.count ? fill(C.screens, { n: s.count }) : C.extended;
  return item('screens', 'ready', { detail });
}

export function displayItems(live: LiveHardware): HardwareItem[] {
  return nativeRows(live.native, 'display') ?? [displayItem(live)];
}

function displayItem(live: LiveHardware): HardwareItem {
  const d = live.native?.customerDisplay;
  if (!d) return item('display', 'unsupported', { detail: C.needsApp });
  if (!d.supported) return item('display', 'unsupported');
  return item('display', d.active ? 'active' : d.available ? 'ready' : 'missing');
}

export function networkItem(live: LiveHardware): HardwareItem {
  const detail = live.queued > 0 ? { detail: fill(C.queued, { n: live.queued }) } : {};
  return live.online
    ? item('network', 'active', { status: C.online, ...detail })
    : item('network', 'error', { status: C.offline, ...detail });
}

export function feedbackItems(probe: Probe, live: LiveHardware): HardwareItem[] {
  const sound =
    live.sound === null
      ? item('sound', 'off', { detail: C.notUsed })
      : live.sound
        ? item('sound', 'active')
        : item('sound', 'off', { status: C.muted });
  const shell = nativeRows(live.native, 'haptics')?.[0];
  const haptics = !live.reads
    ? item('haptics', 'off', { detail: C.notUsed })
    : (shell ??
      (probe.haptics
        ? item('haptics', 'ready')
        : item('haptics', 'unsupported', { detail: C.notInBrowser })));
  const awake = !probe.wakeLock
    ? item('awake', 'unsupported', { detail: C.notInBrowser })
    : item('awake', live.started ? 'active' : 'ready');
  return [sound, haptics, awake];
}

const FOUND = (state: HardwareState) => state !== 'missing' && state !== 'unsupported';

/** Every row, found first; a stable order inside each half. */
export function hardwareItems(browser: Probe, live: LiveHardware): HardwareItem[] {
  const probe = withNativeCameras(browser, live.native);
  const n = live.native;
  const all = [
    ...cameraItems(probe, live),
    wedgeItem(live),
    ...readerItems(live),
    nfcItem(live, probe.webNfc),
    ...keyboardItems(live),
    ...(nativeRows(n, 'usb') ?? peripheralItems('usb', probe.usb)),
    ...peripheralItems('hid', probe.hid),
    ...peripheralItems('serial', probe.serial, live.reads),
    ...(nativeRows(n, 'bluetooth') ?? peripheralItems('bluetooth', probe.bluetooth)),
    ...displayItems(live),
    batteryItem(probe),
    screensItem(probe),
    networkItem(live),
    ...feedbackItems(probe, live),
  ];
  const rows = all.map((i) => pausedOf(i, live));
  return [...rows.filter((i) => FOUND(i.state)), ...rows.filter((i) => !FOUND(i.state))];
}

/** Readers that type into the page get nothing while it has no focus: the old Reader paused chip. */
const TYPES_IN: readonly HardwareKind[] = ['reader', 'wedge', 'keyboard'];
function pausedOf(i: HardwareItem, live: LiveHardware): HardwareItem {
  if (!live.reads || !live.started || live.focused) return i;
  if (!TYPES_IN.includes(i.kind) || (i.state !== 'active' && i.state !== 'ready')) return i;
  return { ...i, state: 'attention', status: C.paused };
}

export const isFound = (i: HardwareItem) => FOUND(i.state);
