import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import '../../lib/test-utils.tsx';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type {
  NativeScannerCapabilities,
  ScanDeviceCapabilities,
} from '../../../shared/contracts/scanning-sessions.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { clearNativeCapabilities, setNativeCapabilities } from '../platform/native-capabilities.ts';
import { sessionFixture } from './session.test-support.ts';
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
  delete document.documentElement.dataset.scanReport;
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
  it('reports a phone layout without requesting camera permission', async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]),
      },
      maxTouchPoints: 2,
    });
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    const workspace = { session: managedSession, device: managedSession.devices[0]! };
    const reportDevice = vi.fn<ScanApi['reportDevice']>().mockResolvedValue(workspace);
    const refetch = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useDeviceReport(
        { reportDevice } as unknown as ScanApi,
        sessionFixture({
          workspace: { ...workspace, device: { ...workspace.device, effectiveSurface: 'phone' } },
        }),
        refetch,
      ),
    );
    await waitFor(() => expect(reportDevice).toHaveBeenCalledOnce());
    expect(reportDevice.mock.calls[0]?.[0]).toMatchObject({
      width: 390,
      height: 844,
      camera: 'available',
      touch: true,
      surfaces: ['phone', 'operator', 'customer'],
      preferred: 'phone',
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  });
  it('retries capability reporting when connectivity returns and removes its listener', async () => {
    const reportDevice = vi
      .fn<ScanApi['reportDevice']>()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValue(null);
    const refetch = vi.fn().mockResolvedValue(undefined);
    const session = sessionFixture({
      workspace: { session: managedSession, device: managedSession.devices[0]! },
    });
    const { unmount } = renderHook(() =>
      useDeviceReport({ reportDevice } as unknown as ScanApi, session, refetch),
    );
    await waitFor(() => expect(document.documentElement.dataset.scanReport).toBe('pending'));
    fireEvent.online(window);
    await waitFor(() => expect(reportDevice).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.documentElement.dataset.scanReport).toBeUndefined());
    unmount();
    fireEvent.online(window);
    expect(reportDevice).toHaveBeenCalledTimes(2);
  });
});
