import { viewOf } from './present.ts';
import type { ScanSnapshot, ScanStore } from './store.ts';
import type { ScanState } from './types.ts';

/** A store that never changes, for the gallery and the preview. */
export function staticStore(
  state: ScanState,
  now: number,
  over: Partial<ScanStore> = {},
): ScanStore {
  const snapshot: ScanSnapshot = { state, view: viewOf(state), now };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    dispatch: () => undefined,
    checkIn: () => undefined,
    configure: () => true,
    retryUnsure: () => undefined,
    dispose: () => undefined,
    ...over,
  };
}
