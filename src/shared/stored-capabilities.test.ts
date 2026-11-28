import { describe, expect, it, vi } from 'vitest';
import { readStoredCapabilities } from './stored-capabilities.ts';

const old = {
  width: 390,
  height: 844,
  touch: true,
  camera: 'available',
  keyboard: true,
  nativeBarcode: false,
  surfaces: ['phone', 'operator', 'customer'],
  preferred: 'phone',
};
const native = {
  platform: 'android',
  appVersion: '2',
  camera: { available: true, permission: 'granted' },
  keyboard: { supported: true, connected: null, connectionObservable: false },
  nfc: { available: true, reading: true, formats: ['tag-uid'] },
  vas: { deviceSupported: false, available: false, reader: 'none', reason: '' },
  externalReader: { mode: 'keyboard', connected: null },
  customerDisplay: { supported: false, available: false, active: false },
};

describe('stored device reports', () => {
  it('reads an old row', () => {
    expect(readStoredCapabilities(JSON.stringify(old))).toEqual({
      ...old,
      surfaces: ['phone', 'operator'],
    });
  });

  it('keeps a row whose preferred layout is a legacy one', () => {
    const read = (surfaces: string[], preferred: string) =>
      readStoredCapabilities(JSON.stringify({ ...old, surfaces, preferred }));
    expect(read(['phone', 'customer'], 'customer')).toMatchObject({
      surfaces: ['phone'],
      preferred: 'phone',
    });
    expect(read(['desk'], 'desk')).toMatchObject({ surfaces: ['phone'], preferred: 'phone' });
    expect(read(['customer', 'operator'], 'desk')).toMatchObject({
      surfaces: ['operator'],
      preferred: 'operator',
    });
  });

  it('reads a row with the hardware summary', () => {
    const row = {
      ...old,
      hardware: [{ kind: 'camera', count: 2, builtIn: true, connected: true, state: 'ready' }],
    };
    expect(readStoredCapabilities(JSON.stringify(row))?.hardware).toHaveLength(1);
  });

  it('drops unknown future fields at any depth and keeps the rest', () => {
    const row = {
      ...old,
      future: { x: 1 },
      native: { ...native, nfc: { ...native.nfc, sun: true }, extra: 'y' },
      hardware: [{ kind: 'nfc', count: 1, builtIn: true, connected: true, state: 'ready', z: 1 }],
    };
    const read = readStoredCapabilities(JSON.stringify(row));
    expect(read).not.toBeNull();
    expect(read && 'future' in read).toBe(false);
    expect(read?.native?.nfc).toEqual(native.nfc);
    expect(read?.hardware?.[0]).toEqual({
      kind: 'nfc',
      count: 1,
      builtIn: true,
      connected: true,
      state: 'ready',
    });
  });

  it('returns null for a row that is not a report, and says why', () => {
    const why = vi.fn();
    expect(readStoredCapabilities('{', why)).toBeNull();
    expect(readStoredCapabilities(JSON.stringify({ ...old, width: 'wide' }), why)).toBeNull();
    expect(why.mock.calls).toEqual([['json'], ['shape']]);
    expect(readStoredCapabilities(null)).toBeNull();
  });
});
