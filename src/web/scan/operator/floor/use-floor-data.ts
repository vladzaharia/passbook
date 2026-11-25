import { useCallback } from 'react';
import type { ScanApi } from '../../api/scan-api.ts';
import { usePolled } from './use-polled.ts';

interface Gate {
  active: boolean;
  online: boolean;
  /** Changes when the hub says a scan happened. */
  kick: number;
}

/** The session's scanners and whether each is connected. */
export function useDevices(api: ScanApi, gate: Gate) {
  const read = useCallback(
    async (signal: AbortSignal) => (await api.devices({ signal })).items,
    [api],
  );
  const polled = usePolled(read, { ...gate, every: 20_000 });
  return { items: polled.data, failed: polled.failed };
}

/** This device's totals since the shift began. */
export function useShift(api: ScanApi, since: number, gate: Gate) {
  const read = useCallback(
    (signal: AbortSignal) => api.summary(since, { signal }, 'device'),
    [api, since],
  );
  const polled = usePolled(read, { ...gate, every: 60_000 });
  return { summary: polled.data, failed: polled.failed };
}
