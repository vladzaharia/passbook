import { useEffect, useRef } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanDeviceCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { reportedCapabilities } from '../../../shared/scan-surfaces.ts';
import type { ScanApi } from '../api/scan-api.ts';

export function deviceCapabilities(): ScanDeviceCapabilities {
  return reportedCapabilities({
    width: Math.max(1, Math.min(32768, Math.round(innerWidth))),
    height: Math.max(1, Math.min(32768, Math.round(innerHeight))),
    touch: matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0,
    camera: typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'unknown' : 'unavailable',
    keyboard: true,
    nativeBarcode: 'PassBookNative' in window,
    surfaces: ['phone', 'customer'],
    preferred: 'phone',
  });
}
/** Reporting capabilities never requests permission or changes the device's authentication. */
export function useDeviceReport(
  api: ScanApi,
  session: ScanSession | null,
  refetch: () => Promise<void>,
) {
  const current = useRef(session);
  current.current = session;
  const scannerId = session?.workspace?.device.id;
  useEffect(() => {
    if (!scannerId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    const report = async () => {
      request?.abort();
      const ac = new AbortController();
      request = ac;
      try {
        const caps = deviceCapabilities();
        if (typeof navigator.mediaDevices?.enumerateDevices === 'function') {
          try {
            if (
              (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === 'videoinput')
            )
              caps.camera = 'available';
          } catch {
            caps.camera = 'unknown';
          }
        }
        if (disposed || ac.signal.aborted) return;
        const next = await api.reportDevice(caps, { signal: ac.signal });
        if (
          !disposed &&
          next &&
          next.device.effectiveSurface !== current.current?.workspace?.device.effectiveSurface
        )
          await refetch();
        delete document.documentElement.dataset.scanReport;
      } catch (error) {
        if (!ac.signal.aborted && !disposed)
          document.documentElement.dataset.scanReport = 'pending';
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void report(), 300);
    };
    void report();
    window.addEventListener('resize', schedule);
    window.addEventListener('online', schedule);
    window.addEventListener('focus', schedule);
    return () => {
      disposed = true;
      request?.abort();
      clearTimeout(timer);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('online', schedule);
      window.removeEventListener('focus', schedule);
    };
  }, [api, scannerId, refetch]);
}
