import { describe, expect, it } from 'vitest';
import {
  androidFixture,
  HW_NOW,
  hardwareCase,
  liveFixture,
  probeFixture,
} from './fixtures.test-support.ts';
import {
  cameraItems,
  hardwareItems,
  isFound,
  nfcItem,
  peripheralItems,
  readerItems,
  wedgeItem,
} from './items.ts';

const byId = (items: ReturnType<typeof hardwareItems>, id: string) =>
  items.find((i) => i.id === id);

describe('hardware rows', () => {
  it('lists every kind, found first, even when nothing is there', () => {
    const items = hardwareItems(probeFixture(), liveFixture());
    const kinds = new Set(items.map((i) => i.kind));
    for (const kind of [
      'camera',
      'wedge',
      'reader',
      'nfc',
      'usb',
      'hid',
      'serial',
      'bluetooth',
      'display',
      'battery',
      'screens',
      'network',
      'sound',
      'haptics',
      'awake',
    ])
      expect(kinds.has(kind as never), kind).toBe(true);
    const firstMissing = items.findIndex((i) => !isFound(i));
    expect(items.slice(firstMissing).every((i) => !isFound(i))).toBe(true);
  });

  it('gives one row per camera, the live one on and the other one tap away', () => {
    const rows = cameraItems(probeFixture(), liveFixture());
    expect(rows.map((r) => [r.name, r.state, r.detail])).toEqual([
      ['Back Camera', 'active', 'Back'],
      ['Front Camera', 'ready', 'Front'],
    ]);
    expect(rows[1]?.action).toEqual({ kind: 'use', choice: 'front' });
  });

  it('names cameras by number until access gives labels, and asks from a tap', () => {
    const { probe, live } = hardwareCase('prompt');
    const [row] = cameraItems(probe, live);
    expect(row).toMatchObject({ name: 'Camera 1', state: 'attention', action: { kind: 'allow' } });
  });

  it('shows a blocked camera with Allow, and a lost one with Retry', () => {
    const { probe, live } = hardwareCase('denied');
    expect(cameraItems(probe, live)[0]).toMatchObject({
      status: 'Blocked',
      action: { kind: 'allow' },
    });
    const lost = cameraItems(
      probeFixture(),
      liveFixture({ camera: 'unavailable', activeCameraId: null }),
    );
    expect(lost[0]).toMatchObject({ state: 'error', status: 'Lost', action: { kind: 'retry' } });
  });

  it('marks wide lenses and offers back-wide', () => {
    const probe = probeFixture({
      cameras: {
        ok: true,
        units: [
          { deviceId: 'a', label: 'Back Camera', facing: 'back' },
          { deviceId: 'b', label: 'Back Ultra Wide Camera', facing: 'back' },
        ],
      },
    });
    const rows = cameraItems(probe, liveFixture({ activeCameraId: 'a' }));
    expect(rows[1]).toMatchObject({
      detail: 'Back · Wide',
      action: { kind: 'use', choice: 'back-wide' },
    });
  });

  it('has no camera rows to act on where the view runs none', () => {
    const rows = cameraItems(probeFixture(), liveFixture({ camera: null }));
    expect(rows.every((r) => r.state === 'ready' && !r.action)).toBe(true);
  });

  it('says not found and not supported apart', () => {
    expect(
      cameraItems(probeFixture({ cameras: { ok: true, units: [] } }), liveFixture())[0]?.state,
    ).toBe('missing');
    expect(cameraItems(probeFixture({ cameras: { ok: false } }), liveFixture())[0]?.state).toBe(
      'unsupported',
    );
  });

  it('detects the wedge by its reads and its layout', () => {
    expect(wedgeItem(liveFixture())).toMatchObject({ state: 'missing', action: { kind: 'test' } });
    const seen = liveFixture({
      wedge: { seenAt: HW_NOW - 5_000, badLayout: false, tracked: true },
    });
    expect(wedgeItem(seen).state).toBe('active');
    expect(wedgeItem({ ...seen, now: HW_NOW + 120_000 }).state).toBe('ready');
    const bad = liveFixture({ wedge: { seenAt: null, badLayout: true, tracked: true } });
    expect(wedgeItem(bad)).toMatchObject({
      state: 'attention',
      detail: 'Set the keyboard to U.S.',
    });
    expect(wedgeItem(liveFixture({ reads: false })).state).toBe('off');
  });

  it('lists granted peripherals one per unit, and says why when there are none', () => {
    expect(
      peripheralItems('hid', { ok: true, units: [{ name: 'Barcode Scanner' }, { name: '' }] }).map(
        (r) => r.name,
      ),
    ).toEqual(['Barcode Scanner', 'HID 2']);
    expect(peripheralItems('usb', { ok: true, units: [] })[0]).toMatchObject({
      state: 'missing',
      detail: 'None paired',
    });
    expect(peripheralItems('bluetooth', { ok: false })[0]?.state).toBe('unsupported');
    expect(peripheralItems('serial', { ok: true, units: [] }, true)[0]?.action).toEqual({
      kind: 'connect',
    });
  });

  it('tracks Web NFC through its tap', () => {
    const at = (webNfc: 'idle' | 'on' | 'denied' | 'error') =>
      nfcItem(liveFixture({ webNfc }), true);
    expect(at('idle')).toMatchObject({ state: 'ready', action: { kind: 'nfc' } });
    expect(at('on').state).toBe('active');
    expect(at('denied')).toMatchObject({ state: 'attention', status: 'Blocked' });
    expect(at('error')).toMatchObject({ state: 'error', action: { kind: 'retry' } });
    expect(nfcItem(liveFixture(), false).state).toBe('unsupported');
  });
});

describe('native hardware (bridge v1)', () => {
  it('lists the Android handheld from the shell: reader, NFC and its cameras', () => {
    const { probe, live } = hardwareCase('android');
    const items = hardwareItems(probe, live);
    expect(byId(items, 'reader:n0')).toMatchObject({
      name: 'Scan engine',
      state: 'active',
      detail: 'Side buttons',
      builtIn: true,
    });
    expect(byId(items, 'nfc:n0')?.state).toBe('ready');
    expect(items.filter((i) => i.kind === 'camera').map((i) => i.name)).toEqual([
      'Rear camera',
      'Front camera',
    ]);
    expect(byId(items, 'haptics:n0')?.state).toBe('ready');
  });

  it('replaces the browser list of a kind rather than adding to it', () => {
    const probe = probeFixture({ usb: { ok: true, units: [{ name: 'Web USB' }] } });
    const native = androidFixture({
      hardware: [
        {
          kind: 'usb',
          id: 'u0',
          name: 'Shell USB',
          builtIn: false,
          connected: true,
          state: 'ready',
        },
      ],
    });
    const usb = hardwareItems(probe, liveFixture({ native })).filter((i) => i.kind === 'usb');
    expect(usb.map((i) => i.name)).toEqual(['Shell USB']);
  });

  it('carries a reason for NFC turned off', () => {
    const { probe, live } = hardwareCase('nfc-off');
    expect(byId(hardwareItems(probe, live), 'nfc:n0')).toMatchObject({
      state: 'off',
      detail: 'NFC is off in Settings',
    });
  });

  it('keeps the old fields working when the shell sends no list', () => {
    const native = androidFixture({ hardware: undefined });
    expect(readerItems(liveFixture({ native }))[0]).toMatchObject({
      state: 'ready',
      detail: 'Barcode',
    });
    expect(nfcItem(liveFixture({ native }), false).state).toBe('active');
  });

  it('shows an attached keyboard as the wedge connected', () => {
    const native = androidFixture({
      hardware: [
        {
          kind: 'keyboard',
          id: 'k0',
          name: 'BT Scanner',
          builtIn: false,
          connected: true,
          state: 'ready',
        },
      ],
    });
    const items = hardwareItems(probeFixture(), liveFixture({ native }));
    expect(byId(items, 'wedge')).toMatchObject({ state: 'ready', detail: 'Connected' });
    expect(byId(items, 'keyboard:n0')?.name).toBe('BT Scanner');
  });
});
