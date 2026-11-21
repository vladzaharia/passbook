import { describe, expect, it, vi } from 'vitest';
import { facingOf, type ProbeEnv, probeHardware, watchHardware } from './probe.ts';

const cam = (label: string, facingMode?: string[], deviceId = label || 'x') =>
  ({
    kind: 'videoinput',
    deviceId,
    label,
    groupId: '',
    ...(facingMode ? { getCapabilities: () => ({ facingMode }) } : {}),
  }) as unknown as MediaDeviceInfo;

const env = (over: Partial<ProbeEnv> = {}): ProbeEnv => ({ canBuzz: false, ...over });

describe('hardware enumeration', () => {
  it('reports every API missing as unsupported, without throwing', async () => {
    const p = await probeHardware(env());
    expect(p).toMatchObject({
      cameras: { ok: false },
      cameraPermission: 'unknown',
      usb: { ok: false },
      hid: { ok: false },
      serial: { ok: false },
      bluetooth: { ok: false },
      battery: null,
      screens: null,
      webNfc: false,
      wakeLock: false,
      haptics: false,
    });
  });

  it('lists cameras one per unit, with facing from capabilities, then the label', async () => {
    const p = await probeHardware(
      env({
        mediaDevices: {
          enumerateDevices: async () => [
            cam('', ['environment'], 'a'),
            cam('FaceTime HD Camera'),
            cam('Logitech BRIO'),
            cam('', undefined, ''),
            { kind: 'audioinput', deviceId: 'm', label: 'Mic', groupId: '' } as MediaDeviceInfo,
          ],
        },
        permissions: { query: async () => ({ state: 'prompt' }) },
      }),
    );
    expect(p.cameraPermission).toBe('prompt');
    expect(p.cameras).toEqual({
      ok: true,
      units: [
        { deviceId: 'a', label: '', facing: 'back' },
        { deviceId: 'FaceTime HD Camera', label: 'FaceTime HD Camera', facing: 'front' },
        { deviceId: 'Logitech BRIO', label: 'Logitech BRIO', facing: 'external' },
        { deviceId: '', label: '', facing: null },
      ],
    });
  });

  it('lists granted peripherals only, present and absent', async () => {
    const p = await probeHardware(
      env({
        usb: { getDevices: async () => [] },
        hid: { getDevices: async () => [{ productName: 'Barcode Scanner', opened: true }] },
        serial: { getPorts: async () => [{ readable: {} }, { readable: null }] },
        bluetooth: { getDevices: async () => [{ name: 'Ring scanner' }] },
      }),
    );
    expect(p.usb).toEqual({ ok: true, units: [] });
    expect(p.hid).toEqual({ ok: true, units: [{ name: 'Barcode Scanner', open: true }] });
    expect(p.serial).toEqual({ ok: true, units: [{ name: '', open: true }, { name: '' }] });
    expect(p.bluetooth).toEqual({ ok: true, units: [{ name: 'Ring scanner' }] });
  });

  it('treats an API a policy forbids as unsupported', async () => {
    const p = await probeHardware(
      env({ hid: { getDevices: () => Promise.reject(new Error('policy')) } }),
    );
    expect(p.hid).toEqual({ ok: false });
  });

  it('reads battery, NFC, wake lock and haptics', async () => {
    const p = await probeHardware(
      env({
        getBattery: async () => ({ level: 0.5, charging: true }),
        ndefReader: class {},
        wakeLock: {},
        canBuzz: true,
      }),
    );
    expect(p).toMatchObject({
      battery: { level: 0.5, charging: true },
      webNfc: true,
      wakeLock: true,
      haptics: true,
    });
  });

  it('counts screens only when window management is already allowed', async () => {
    const details = vi.fn(async () => ({ screens: [1, 2, 3] }));
    const denied = await probeHardware(
      env({
        screen: { isExtended: true },
        getScreenDetails: details,
        permissions: { query: async () => ({ state: 'prompt' }) },
      }),
    );
    expect(denied.screens).toEqual({ count: null, extended: true });
    expect(details).not.toHaveBeenCalled();
    const granted = await probeHardware(
      env({
        screen: { isExtended: true },
        getScreenDetails: details,
        permissions: { query: async () => ({ state: 'granted' }) },
      }),
    );
    expect(granted.screens).toEqual({ count: 3, extended: true });
    expect((await probeHardware(env({ screen: { isExtended: false } }))).screens).toEqual({
      count: 1,
      extended: false,
    });
  });

  it('never calls an API that prompts', async () => {
    const requestDevice = vi.fn();
    const getUserMedia = vi.fn();
    await probeHardware(
      env({
        mediaDevices: { enumerateDevices: async () => [], getUserMedia } as never,
        hid: { getDevices: async () => [], requestDevice } as never,
      }),
    );
    expect(requestDevice).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('falls back to the label when capabilities throw', () => {
    const d = {
      ...cam('Rear camera'),
      getCapabilities: () => {
        throw new Error('no');
      },
    } as unknown as MediaDeviceInfo;
    expect(facingOf(d)).toBe('back');
  });

  it('re-enumerates on device, connect and permission events, and stops', async () => {
    const media = new EventTarget();
    const hid = new EventTarget();
    const status = new EventTarget();
    const onChange = vi.fn();
    const stop = watchHardware(
      env({
        mediaDevices: media as never,
        hid: hid as never,
        permissions: { query: async () => status as never },
      }),
      onChange,
    );
    await Promise.resolve();
    await Promise.resolve();
    media.dispatchEvent(new Event('devicechange'));
    hid.dispatchEvent(new Event('connect'));
    status.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
    hid.dispatchEvent(new Event('disconnect'));
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
