import { fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import '../../lib/test-utils.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { sessionFixture } from './session.test-support.ts';
import { useDeviceReport } from './use-device-report.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.scanReport;
});
describe('device capability reporting', () => {
  it('reports a phone’s responsive layouts and inputs without requesting camera permission', async () => {
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
      surfaces: ['phone', 'operator', 'desk', 'customer'],
      preferred: 'phone',
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    await waitFor(() => expect(refetch).toHaveBeenCalledOnce());
  });
  it('retries a failed report when connectivity returns and removes listeners on unmount', async () => {
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
