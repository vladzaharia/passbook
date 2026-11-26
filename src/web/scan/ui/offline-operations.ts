import { useEffect } from 'react';
import { formatTime } from '../../lib/format.ts';
import { type LocalOperationDef, useLocalOperation } from '../../ui/operation/index.ts';
import type { ScanState } from '../machine/types.ts';

const LIST: LocalOperationDef = {
  kind: 'scan.offline-list',
  title: 'Offline list',
  steps: [{ key: 'list', label: 'Download the list' }],
};
const SYNC: LocalOperationDef = {
  kind: 'scan.offline-sync',
  title: 'Sync entries',
  doneTitle: 'Entries synced',
  steps: [{ key: 'send', label: 'Send saved entries', active: 'Sending saved entries' }],
};

/**
 * The offline panel's two rows on the local driver, like the server-driven ones: the list (waiting
 * for a first download, or current as of a time) and the sync while it runs. The controller reports
 * the list's age and whether a sync runs, so the rows carry no counts.
 */
export function useOfflineOperations(offline: ScanState['offline'], timeZone?: string) {
  const list = useLocalOperation(LIST, timeZone);
  const sync = useLocalOperation(SYNC, timeZone);
  const { mode, listAt, syncing } = offline;
  const { driver: listDriver } = list;
  const { driver: syncDriver } = sync;
  useEffect(() => {
    if (mode !== 'list') return;
    if (listAt === null) listDriver.wait('list', 'No list yet. Stay online until it loads.');
    else {
      listDriver.step('list');
      listDriver.complete('list');
      listDriver.finish(null, `From ${formatTime(listAt, timeZone)}`);
    }
  }, [mode, listAt, timeZone, listDriver]);
  useEffect(() => {
    if (syncing) syncDriver.step('send');
    else if (syncDriver.snapshot().status === 'running') {
      syncDriver.complete('send');
      syncDriver.finish();
    }
  }, [syncing, syncDriver]);
  return { list: list.operation, sync: sync.operation };
}
