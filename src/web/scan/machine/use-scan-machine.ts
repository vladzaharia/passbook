/** `useScanMachine()` (C10): the state, the view and `dispatch` of the store in context. */
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ScanView } from './present.ts';
import type { ScanStore } from './store.ts';
import type { ScanEvent, ScanState } from './types.ts';

export const ScanStoreContext = createContext<ScanStore | null>(null);

export interface ScanMachine {
  state: ScanState;
  view: ScanView;
  /** The store clock at the last change, for hints that depend on elapsed time. */
  now: number;
  dispatch: (event: ScanEvent) => void;
}

export function useScanMachine(): ScanMachine {
  const store = useContext(ScanStoreContext);
  if (!store) throw new Error('useScanMachine needs a ScanStoreContext.Provider');
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { state: snap.state, view: snap.view, now: snap.now, dispatch: store.dispatch };
}
