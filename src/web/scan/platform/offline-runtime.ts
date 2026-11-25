import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { offlineModeOf } from '../../../shared/scan-offline.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import type { ScanApi } from '../api/scan-api.ts';
import type { ClockPort } from '../machine/ports.ts';
import type { ScanStore } from '../machine/store.ts';
import { createOfflineController, type OfflineController } from '../offline/controller.ts';
import { createQueueStore, type QueueRow } from '../offline/queue-store.ts';
import { createRosterStore, type RosterEntry, type RosterMeta } from '../offline/roster.ts';
import { registerShell } from '../offline/sw-shell.ts';
import { registerSync } from '../offline/sync-gate.ts';
import type { KeyValue, LocalStores } from '../offline/wipe.ts';

/** The roster's scope on the device: the scanning session and its config revision. */
export const offlineScopeOf = (s: ScanSession): string =>
  `${s.workspace?.session?.id ?? s.scanner?.id ?? ''}:${s.counts.configRev}`;

/** Offline check-in for a paired door whose session asks for it; null for Stop and for an admin. */
export function connectOffline(a: {
  scanner: ScanSession['scanner'];
  api: ScanApi;
  stores: LocalStores;
  clock: ClockPort;
  store: ScanStore;
  /** The session as it is now: its id and config revision key the roster. */
  session: () => ScanSession;
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
    scope: () => offlineScopeOf(a.session()),
    timeZone: () => a.session().scanner?.timeZone ?? DEFAULT_TIME_ZONE,
    counts: () => store.getSnapshot().state.counts,
    emit: {
      outcome: (key, outcome) => store.dispatch({ type: 'offline', key, outcome }),
      queue: (q) => store.dispatch({ type: 'queue', ...q }),
      status: (s) => store.dispatch({ type: 'offline.status', ...s }),
    },
  });
  registerSync(() => controller.syncNow());
  void controller.start();
  void registerShell();
  return controller;
}
