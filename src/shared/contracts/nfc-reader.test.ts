import { describe, expect, it } from 'vitest';
import { NfcReaderSettingsSchema, NfcReaderStatusSchema } from './nfc-reader.ts';
import { ScanDeviceCapabilitiesSchema } from './scan-device.ts';
import { ScanningDeviceSchema } from './scanning-sessions.ts';

const status = {
  state: 'ready',
  model: 'acr1555u',
  transport: 'bluetooth',
  pinned: true,
  label: 'ACR1555U ·4F21',
  firmware: '1.3.1',
  battery: { percent: 80, low: false, charging: null },
  code: null,
  reportedAt: 1,
};

describe('NfcReaderSettingsSchema', () => {
  it('takes the three fields and nothing else', () => {
    const ok = { use: true, model: 'any', connection: 'auto' };
    expect(NfcReaderSettingsSchema.safeParse(ok).success).toBe(true);
    expect(NfcReaderSettingsSchema.safeParse({ ...ok, serial: 'x' }).success).toBe(false);
    expect(NfcReaderSettingsSchema.safeParse({ ...ok, model: 'acr122' }).success).toBe(false);
    expect(NfcReaderSettingsSchema.safeParse({ ...ok, connection: 'nfc' }).success).toBe(false);
    expect(NfcReaderSettingsSchema.safeParse({ model: 'any', connection: 'usb' }).success).toBe(
      false,
    );
  });
});

describe('NfcReaderStatusSchema', () => {
  it('parses a ready reader, a keyboard reader and no reader', () => {
    expect(NfcReaderStatusSchema.safeParse(status).success).toBe(true);
    expect(
      NfcReaderStatusSchema.safeParse({
        ...status,
        state: 'keyboard',
        model: null,
        transport: 'keyboard',
        battery: null,
      }).success,
    ).toBe(true);
    expect(
      NfcReaderStatusSchema.safeParse({
        ...status,
        state: 'none',
        model: null,
        transport: null,
        label: null,
        firmware: null,
        battery: null,
      }).success,
    ).toBe(true);
  });

  it('bounds the label, firmware, battery and code', () => {
    const bad = (extra: object) => NfcReaderStatusSchema.safeParse({ ...status, ...extra }).success;
    expect(bad({ label: 'x'.repeat(41) })).toBe(false);
    expect(bad({ firmware: 'x'.repeat(33) })).toBe(false);
    expect(bad({ battery: { percent: 101, low: false, charging: null } })).toBe(false);
    expect(bad({ code: 'READER_LOCKED' })).toBe(true);
    expect(bad({ code: 'NOPE' })).toBe(false);
    expect(bad({ state: 'off' })).toBe(false);
    expect(bad({ serial: 'x' })).toBe(false);
  });
});

describe('where the schemas appear', () => {
  it('a device report carries the status without reportedAt', () => {
    const { reportedAt: _drop, ...reported } = status;
    const caps = {
      width: 1,
      height: 1,
      touch: true,
      camera: 'available',
      keyboard: false,
      nativeBarcode: false,
      surfaces: ['phone'],
      preferred: 'phone',
    };
    expect(ScanDeviceCapabilitiesSchema.safeParse({ ...caps, nfcReader: reported }).success).toBe(
      true,
    );
    expect(ScanDeviceCapabilitiesSchema.safeParse({ ...caps, nfcReader: status }).success).toBe(
      false,
    );
    expect(ScanDeviceCapabilitiesSchema.safeParse(caps).success).toBe(true);
  });

  it('a device read may carry the setting and its status', () => {
    expect(ScanningDeviceSchema.shape.nfcReader.safeParse(undefined).success).toBe(true);
    expect(ScanningDeviceSchema.shape.nfcReaderStatus.safeParse(null).success).toBe(true);
    expect(ScanningDeviceSchema.shape.nfcReaderStatus.safeParse(status).success).toBe(true);
    expect(
      ScanningDeviceSchema.shape.nfcReader.safeParse({
        use: false,
        model: 'any',
        connection: 'usb',
      }).success,
    ).toBe(true);
  });
});
