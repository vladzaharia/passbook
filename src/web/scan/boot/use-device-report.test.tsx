import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type {
  NativeScannerCapabilities,
  ScanDeviceCapabilities,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { clearNativeCapabilities, setNativeCapabilities } from '../platform/native-capabilities.ts';
import { deviceCapabilities, useDeviceReport } from './use-device-report.ts';

const iosCapabilities: NativeScannerCapabilities = {
  platform: 'ios',
  appVersion: '1',
  camera: { available: true, permission: 'granted' },
  keyboard: { supported: true, connected: null, connectionObservable: false },
  nfc: { available: true, reading: false, formats: ['ndef'] },
  vas: {
    deviceSupported: true,
    available: false,
    reader: 'proximityReader',
    reason: 'Wallet VAS needs an Apple entitlement and payment provider.',
  },
  externalReader: { mode: 'keyboard', connected: null },
  customerDisplay: { supported: false, available: false, active: false },
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearNativeCapabilities();
});

describe('scanner device capabilities', () => {
  it('distinguishes iOS camera decoding from native barcode input', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const capabilities = deviceCapabilities(iosCapabilities);
    expect(capabilities.nativeBarcode).toBe(false);
    expect(capabilities.native).toEqual(iosCapabilities);
    expect(capabilities.native?.vas.available).toBe(false);
    expect(capabilities.native?.nfc.formats).toEqual(['ndef']);
  });
  it('reports Android hardware separately from end-to-end VAS verification', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const android: NativeScannerCapabilities = {
      ...iosCapabilities,
      platform: 'android',
      camera: { available: true, permission: 'unknown' },
      nfc: { available: true, reading: true, formats: ['wallet-vas'] },
      vas: {
        deviceSupported: true,
        available: false,
        reader: 'android-native',
        reason: 'Backend VAS verification is unavailable.',
      },
    };
    const capabilities = deviceCapabilities(android);
    expect(capabilities.nativeBarcode).toBe(true);
    expect(capabilities.native?.nfc.formats).toEqual(['wallet-vas']);
    expect(capabilities.native?.vas.available).toBe(false);
  });

  it('re-reports native capability changes to the session device API', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const reportDevice = vi.fn(async (_caps: ScanDeviceCapabilities) => null);
    const api = { reportDevice } as unknown as ScanApi;
    const session = {
      workspace: { device: { id: 'device-1', effectiveSurface: 'phone' } },
    } as unknown as ScanSession;
    const refetch = vi.fn(async () => {});
    const hook = renderHook(() => useDeviceReport(api, session, refetch));

    await waitFor(() => expect(reportDevice).toHaveBeenCalledTimes(1));
    await act(async () => setNativeCapabilities(iosCapabilities));
    await waitFor(() => expect(reportDevice).toHaveBeenCalledTimes(2));
    expect(reportDevice.mock.calls[1]?.[0].native).toEqual(iosCapabilities);
    expect(reportDevice.mock.calls[1]?.[0].nativeBarcode).toBe(false);
    hook.unmount();
  });
});
