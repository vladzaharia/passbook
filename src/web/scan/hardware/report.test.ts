import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NativeHardwareEntrySchema,
  sanitizeNativeHardware,
} from '../../../shared/contracts/scan-hardware.ts';
import {
  NativeScannerCapabilitiesSchema,
  ScanDeviceCapabilitiesSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { deviceCapabilities } from '../boot/use-device-report.ts';
import {
  clearNativeCapabilities,
  getNativeCapabilities,
  setNativeCapabilities,
} from '../platform/native-capabilities.ts';
import { androidFixture, hardwareCase } from './fixtures.test-support.ts';
import { hardwareItems } from './items.ts';
import { publishHardware, summarize } from './report.ts';

const android = () => {
  const { probe, live } = hardwareCase('android');
  return hardwareItems(probe, live);
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  return () => vi.unstubAllGlobals();
});

describe('hardware summary for the server', () => {
  it('carries kinds, counts, builtIn, connected and state only', () => {
    const summary = summarize(android());
    expect(summary).toEqual([
      { kind: 'camera', count: 1, builtIn: true, connected: true, state: 'active' },
      { kind: 'camera', count: 1, builtIn: true, connected: true, state: 'ready' },
      { kind: 'barcode', count: 1, builtIn: true, connected: true, state: 'active' },
      { kind: 'nfc', count: 1, builtIn: true, connected: true, state: 'ready' },
    ]);
    const text = JSON.stringify(summary);
    for (const secret of ['Rear camera', 'Scan engine', 'c0', 'b0'])
      expect(text).not.toContain(secret);
  });

  it('reports a seen wedge and a serial scanner, not missing kinds', () => {
    const { probe, live } = hardwareCase('wedge');
    const kinds = new Set(summarize(hardwareItems(probe, live)).map((h) => h.kind));
    expect([...kinds]).toEqual(['camera', 'keyboard', 'serial']);
  });

  it('is what the device report sends, with the shell list left out', () => {
    publishHardware(android());
    const caps = deviceCapabilities(androidFixture());
    expect(caps.native && 'hardware' in caps.native).toBe(false);
    expect(caps.hardware?.[0]).toEqual({
      kind: 'camera',
      count: 1,
      builtIn: true,
      connected: true,
      state: 'active',
    });
    expect(ScanDeviceCapabilitiesSchema.safeParse(caps).success).toBe(true);
  });

  it('is refused by the server schema when it carries a name or the shell list', () => {
    const caps = deviceCapabilities(androidFixture());
    const named = {
      ...caps,
      hardware: [
        { kind: 'camera', count: 1, builtIn: true, connected: true, state: 'ready', name: 'Rear' },
      ],
    };
    expect(ScanDeviceCapabilitiesSchema.safeParse(named).success).toBe(false);
    const listed = { ...caps, native: androidFixture() };
    expect(ScanDeviceCapabilitiesSchema.safeParse(listed).success).toBe(false);
  });
});

describe('native hardware snapshot (bridge v1)', () => {
  it('parses an old snapshot without the list and a new one with it', () => {
    const { hardware: _h, ...old } = androidFixture();
    expect(NativeScannerCapabilitiesSchema.safeParse(old).success).toBe(true);
    expect(NativeScannerCapabilitiesSchema.safeParse(androidFixture()).success).toBe(true);
  });

  it('drops a malformed entry alone and keeps the snapshot', () => {
    const hardware = [
      ...(androidFixture().hardware ?? []),
      { kind: 'laser', id: 'z', builtIn: true, connected: true, state: 'ready' },
      { kind: 'usb', id: 'x'.repeat(65), builtIn: false, connected: true, state: 'ready' },
    ];
    setNativeCapabilities({ ...androidFixture(), hardware });
    expect(getNativeCapabilities()?.hardware).toHaveLength(5);
    expect(getNativeCapabilities()?.platform).toBe('android');
    clearNativeCapabilities();
  });

  it('keeps at most 16 entries', () => {
    const entry = { kind: 'usb', id: 'u', builtIn: false, connected: true, state: 'ready' };
    expect(sanitizeNativeHardware(Array.from({ length: 40 }, () => entry))).toHaveLength(16);
    expect(sanitizeNativeHardware('nope')).toBeUndefined();
  });

  it('bounds names and reasons', () => {
    const base = { kind: 'camera', id: 'c', builtIn: true, connected: null, state: 'ready' };
    expect(NativeHardwareEntrySchema.safeParse({ ...base, name: 'n'.repeat(81) }).success).toBe(
      false,
    );
    expect(NativeHardwareEntrySchema.safeParse({ ...base, reason: 'r'.repeat(121) }).success).toBe(
      false,
    );
    expect(NativeHardwareEntrySchema.safeParse(base).success).toBe(true);
  });
});
