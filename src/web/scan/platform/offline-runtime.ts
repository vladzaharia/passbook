import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { offlineModeOf } from '../../../shared/scan-offline.ts';
import type { ScanApi } from '../api/scan-api.ts';
import type { ClockPort } from '../machine/ports.ts';
import type { ScanStore } from '../machine/store.ts';
import { createOfflineController, type OfflineController } from '../offline/controller.ts';
import { createQueueStore, type QueueRow } from '../offline/queue-store.ts';
import { createRosterStore, type RosterEntry, type RosterMeta } from '../offline/roster.ts';
import type { KeyValue, LocalStores } from '../offline/wipe.ts';

/** Offline check-in for a paired door whose session asks for it; null for Stop and for an admin. */
export function connectOffline(a: {
  scanner: ScanSession['scanner'];
  api: ScanApi;
  stores: LocalStores;
  clock: ClockPort;
  store: ScanStore;
}): OfflineController | null {
  const { scanner, store } = a;
  const mode = scanner ? offlineModeOf(scanner.settings) : 'stop';
  if (!scanner || mode === 'stop') return null;
  const controller = createOfflineController({
    mode,
    scannerId: scanner.id,
    api: a.api,
    queue: createQueueStore(a.stores.queue as KeyValue<QueueRow>),
    roster: createRosterStore(
      a.stores.roster as KeyValue<RosterEntry>,
      a.stores.meta as KeyValue<RosterMeta>,
    ),
    meta: a.stores.meta as KeyValue<number>,
    clock: a.clock,
    online: () => navigator.onLine,
    counts: () => store.getSnapshot().state.counts,
    emit: {
      outcome: (key, outcome) => store.dispatch({ type: 'offline', key, outcome }),
      queue: (q) => store.dispatch({ type: 'queue', ...q }),
      status: (s) => store.dispatch({ type: 'offline.status', ...s }),
    },
  });
  void controller.start();
  return controller;
}
