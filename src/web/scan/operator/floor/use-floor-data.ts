import { useCallback, useState } from 'react';
import { VISITOR_COPY } from '../../../../shared/copy/visitors.ts';
import { localDay } from '../../../lib/visitors.ts';
import { toast } from '../../../ui/toaster.tsx';
import type { ScanApi } from '../../api/scan-api.ts';
import { scanId } from '../../platform/id.ts';
import { usePolled } from './use-polled.ts';

interface Gate {
  active: boolean;
  online: boolean;
  /** Changes when the hub says a scan happened. */
  kick: number;
}

/** Today's visitors, refreshed by the hub and every 30 s; Check out signs one out. */
export function useVisitors(api: ScanApi, gate: Gate) {
  const read = useCallback(
    async (signal: AbortSignal) => (await api.visitors(localDay(), { signal })).items,
    [api],
  );
  const polled = usePolled(read, { ...gate, every: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const checkOut = async (visitor: { id: string; passId: string; name: string }) => {
    setBusy(visitor.id);
    try {
      await api.signOutPerson({ idempotencyKey: scanId(), passId: visitor.passId, tag: 'none' });
      toast.success(`${VISITOR_COPY.desk.checkedOut}: ${visitor.name}`);
      await polled.reload();
    } catch (error) {
      toast.error(error, 'Could not check out');
    } finally {
      setBusy(null);
    }
  };
  return { items: polled.data, failed: polled.failed, busy, checkOut };
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
