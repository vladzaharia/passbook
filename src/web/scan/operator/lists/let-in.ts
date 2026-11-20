import { useCallback, useState } from 'react';
import type { ScanLiveRow } from '../../../../shared/contracts/scan-setups.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { useLetIn } from '../../live/monitor-desk.tsx';
import type { ActivityItem } from './activity-model.ts';
import type { Settled } from './problems-model.ts';

/** The monitor's let-in flow wants a feed row; the fields it reads are the scan, the name and the kind. */
function liveRowOf(item: ActivityItem): ScanLiveRow {
  return {
    id: item.id,
    at: item.at,
    scannerId: item.deviceId,
    scannerName: item.deviceName,
    passId: item.passId,
    holder: item.title,
    photoUrl: null,
    kind: item.outcome === 'heads_up' ? 'heads_up' : 'refused',
    direction: item.direction,
    label: item.title ?? '',
    presented: false,
    ...(item.scanId ? { scanId: item.scanId } : {}),
  };
}

/**
 * Let in from Problems: the same one-tap flow, Manager PIN and undo toast as the desk monitor
 * (`useLetIn`), plus what this device has settled so far. `refresh` reloads the list after.
 */
export function useProblemActions(api: ScanApi, who: string | null, refresh: () => void) {
  const [settled, setSettled] = useState<ReadonlyMap<string, Settled>>(new Map());
  const settle = useCallback(
    (id: string, how: Settled['how']) =>
      setSettled((held) => new Map(held).set(id, { by: who, how })),
    [who],
  );
  const desk = useLetIn(
    api,
    (row) => {
      settle(row.id, 'let_in');
      refresh();
    },
    (row) =>
      setSettled((held) => {
        const next = new Map(held);
        next.delete(row.id);
        return next;
      }),
  );
  return {
    settled,
    seen: (id: string) => settle(id, 'seen'),
    letIn: (item: ActivityItem) => desk.letIn(liveRowOf(item)),
    sheet: desk.sheet,
  };
}
